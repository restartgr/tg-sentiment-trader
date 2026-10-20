import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  DEFAULT_ROUTING_THRESHOLDS,
  isHeatTriggered,
  isScoreTriggered,
  shouldDeepAnalyze,
  triggerReason,
  type TriggerReason,
} from "./routing";
import type { ReplaySnapshot } from "./replay-snapshot";
import {
  isReplayThresholds,
  loadReplaySnapshotFile,
  saveJsonReport,
} from "./rule-replay-support";

export { validateReplaySnapshot } from "./rule-replay-support";

export interface ReplayThresholds {
  scoreMin: number;
  heatDeepMin: number;
}

export interface RuleReplayResult {
  decision: "quick" | "deep_required";
  triggerReason: TriggerReason;
}

export interface RuleReplayReport {
  schemaVersion: 1;
  mode: "rules_only";
  replayId: string;
  generatedAt: string;
  batchId: number;
  snapshotSha256: string;
  input: ReplaySnapshot["input"];
  thresholds: ReplayThresholds;
  historicalResult: ReplaySnapshot["historicalResult"];
  replayResult: RuleReplayResult;
  comparison: {
    historicalDecision: RuleReplayResult["decision"] | "unknown";
    sameDecision: boolean | null;
    historicalThresholdsKnown: false;
  };
}

export function replayQuickDecision(
  snapshot: Pick<ReplaySnapshot, "input">,
  thresholds: ReplayThresholds,
): RuleReplayResult {
  if (!isReplayThresholds(thresholds)) {
    throw new Error("Replay thresholds must be between 0 and 1");
  }
  const scoreTriggered = isScoreTriggered(snapshot.input.quickScore, thresholds.scoreMin);
  const heatTriggered = isHeatTriggered(snapshot.input.quickHeat, thresholds.heatDeepMin);
  return {
    decision: shouldDeepAnalyze(
      snapshot.input.quickScore,
      snapshot.input.quickHeat,
      thresholds.scoreMin,
      thresholds.heatDeepMin,
    ) ? "deep_required" : "quick",
    triggerReason: triggerReason(scoreTriggered, heatTriggered),
  };
}

export function makeRuleReplayReport(
  snapshot: ReplaySnapshot,
  snapshotSha256: string,
  thresholds: ReplayThresholds,
): RuleReplayReport {
  const replayResult = replayQuickDecision(snapshot, thresholds);
  const historicalTier = snapshot.historicalResult.tier;
  const historicalDecision = historicalTier === "quick"
    ? "quick"
    : [
        "simple",
        "monitor",
        "detail",
        "directional",
        "downgraded",
        "direction_upgraded_no_market",
        "overheat_push",
        "overheat_silent",
      ].includes(historicalTier)
      ? "deep_required"
      : "unknown";
  return {
    schemaVersion: 1,
    mode: "rules_only",
    replayId: randomUUID(),
    generatedAt: new Date().toISOString(),
    batchId: snapshot.batchId,
    snapshotSha256,
    input: snapshot.input,
    thresholds,
    historicalResult: snapshot.historicalResult,
    replayResult,
    comparison: {
      historicalDecision,
      sameDecision:
        historicalDecision === "unknown"
          ? null
          : replayResult.decision === historicalDecision,
      historicalThresholdsKnown: false,
    },
  };
}

export async function saveRuleReplayReport(
  report: RuleReplayReport,
  reportDir = path.join(process.cwd(), "data", "replay", "reports"),
): Promise<string> {
  const reportPath = path.join(reportDir, `batch-${report.batchId}-${report.replayId}.json`);
  return saveJsonReport(reportPath, report);
}

function parseCliArgs(args: string[]): { batchId: number; thresholds: ReplayThresholds } {
  if (args.length < 2 || args[0] !== "--batch" || !/^\d+$/.test(args[1])) {
    throw new Error("Usage: pnpm replay --batch <id> [--score-min <0..1>] [--heat-deep-min <0..1>]");
  }
  const batchId = Number(args[1]);
  if (!Number.isSafeInteger(batchId) || batchId < 1) {
    throw new Error("Batch ID must be a positive integer");
  }
  const thresholds: ReplayThresholds = { ...DEFAULT_ROUTING_THRESHOLDS };
  const seen = new Set<string>();
  for (let i = 2; i < args.length; i += 2) {
    const name = args[i];
    const raw = args[i + 1];
    if (!raw || seen.has(name) || !/^(?:0|1|0?\.\d+)$/.test(raw)) {
      throw new Error("Invalid replay threshold arguments");
    }
    seen.add(name);
    if (name === "--score-min") thresholds.scoreMin = Number(raw);
    else if (name === "--heat-deep-min") thresholds.heatDeepMin = Number(raw);
    else throw new Error(`Unknown replay option: ${name}`);
  }
  return { batchId, thresholds };
}

async function main(): Promise<void> {
  const { batchId, thresholds } = parseCliArgs(process.argv.slice(2));
  const { snapshot, snapshotSha256 } = await loadReplaySnapshotFile(batchId);
  const report = makeRuleReplayReport(snapshot, snapshotSha256, thresholds);
  const reportPath = await saveRuleReplayReport(report);
  console.log(`Saved replay report: ${reportPath}`);
  console.log(JSON.stringify({
    batchId,
    historicalDecision: report.comparison.historicalDecision,
    replayResult: report.replayResult,
    sameDecision: report.comparison.sameDecision,
    historicalThresholdsKnown: false,
  }));
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Replay failed");
    process.exitCode = 1;
  });
}

import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  replayQuickDecision,
  type ReplayThresholds,
  type RuleReplayResult,
} from "./replay";
import type { ReplaySnapshot } from "./replay-snapshot";
import {
  isRecord,
  isReplayInput,
  isReplayThresholds,
  loadReplaySnapshotFile,
  saveJsonReport,
} from "./rule-replay-support";

type EvalInput = ReplaySnapshot["input"];
type EvalSource = { kind: "inline" } | {
  kind: "replay_snapshot";
  batchId: number;
  snapshotSha256: string;
};

export interface RoutingEvalCase {
  id: string;
  input?: EvalInput;
  batchId?: number;
  thresholds: ReplayThresholds;
  expected: RuleReplayResult;
}

export interface RoutingEvalResult {
  id: string;
  source: EvalSource;
  input: EvalInput;
  thresholds: ReplayThresholds;
  expected: RuleReplayResult;
  actual: RuleReplayResult;
  pass: boolean;
  differences: Array<{
    field: keyof RuleReplayResult;
    expected: string;
    actual: string;
  }>;
}

export interface RoutingEvalReport {
  schemaVersion: 1;
  mode: "rules_only";
  evalId: string;
  generatedAt: string;
  casesSha256: string;
  routingCodeSha256: string;
  summary: { total: number; passed: number; failed: number; passRate: number };
  results: RoutingEvalResult[];
}

function validateCase(value: unknown): RoutingEvalCase {
  if (!isRecord(value) || !isRecord(value.expected)) {
    throw new Error("Invalid routing eval case");
  }
  const hasInput = value.input !== undefined;
  const hasBatchId = value.batchId !== undefined;
  if (
    typeof value.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(value.id) ||
    hasInput === hasBatchId ||
    !isReplayThresholds(value.thresholds) ||
    !["quick", "deep_required"].includes(value.expected.decision as string) ||
    !["score", "heat", "both", "none"].includes(value.expected.triggerReason as string)
  ) {
    throw new Error(`Invalid routing eval case: ${String(value.id ?? "unknown")}`);
  }
  if (hasInput) {
    if (!isReplayInput(value.input)) {
      throw new Error(`Invalid routing eval input: ${value.id}`);
    }
  } else if (!Number.isSafeInteger(value.batchId) || (value.batchId as number) < 1) {
    throw new Error(`Invalid routing eval batch ID: ${value.id}`);
  }
  return value as unknown as RoutingEvalCase;
}

export function validateCaseSet(value: unknown): RoutingEvalCase[] {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.cases) || value.cases.length === 0) {
    throw new Error("Invalid routing eval case set");
  }
  const cases = value.cases.map(validateCase);
  if (new Set(cases.map((item) => item.id)).size !== cases.length) {
    throw new Error("Routing eval case IDs must be unique");
  }
  return cases;
}

async function resolveInput(evalCase: RoutingEvalCase): Promise<{ input: EvalInput; source: EvalSource }> {
  if (evalCase.input) return { input: evalCase.input, source: { kind: "inline" } };
  const batchId = evalCase.batchId as number;
  const { snapshot, snapshotSha256 } = await loadReplaySnapshotFile(batchId);
  return {
    input: snapshot.input,
    source: {
      kind: "replay_snapshot",
      batchId,
      snapshotSha256,
    },
  };
}

export async function evaluateCase(evalCase: RoutingEvalCase): Promise<RoutingEvalResult> {
  const { input, source } = await resolveInput(evalCase);
  const actual = replayQuickDecision({ input }, evalCase.thresholds);
  const differences: RoutingEvalResult["differences"] = [];
  for (const field of ["decision", "triggerReason"] as const) {
    if (actual[field] !== evalCase.expected[field]) {
      differences.push({ field, expected: evalCase.expected[field], actual: actual[field] });
    }
  }
  return {
    id: evalCase.id,
    source,
    input,
    thresholds: evalCase.thresholds,
    expected: evalCase.expected,
    actual,
    pass: differences.length === 0,
    differences,
  };
}

export async function runRoutingEval(
  cases: RoutingEvalCase[],
  casesSha256: string,
  routingCodeSha256: string,
): Promise<RoutingEvalReport> {
  if (cases.length === 0) throw new Error("Routing eval requires at least one case");
  const results: RoutingEvalResult[] = [];
  for (const evalCase of cases) results.push(await evaluateCase(evalCase));
  const passed = results.filter((result) => result.pass).length;
  return {
    schemaVersion: 1,
    mode: "rules_only",
    evalId: randomUUID(),
    generatedAt: new Date().toISOString(),
    casesSha256,
    routingCodeSha256,
    summary: {
      total: results.length,
      passed,
      failed: results.length - passed,
      passRate: passed / results.length,
    },
    results,
  };
}

export async function saveRoutingEvalReport(
  report: RoutingEvalReport,
  reportDir = path.join(process.cwd(), "data", "eval", "reports"),
): Promise<string> {
  const reportPath = path.join(reportDir, `routing-${report.evalId}.json`);
  return saveJsonReport(reportPath, report);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== "--cases" || !args[1])) {
    throw new Error("Usage: pnpm eval:tg [--cases <case-set.json>]");
  }
  const casesPath = path.resolve(process.cwd(), args[1] ?? "eval/routing-cases.json");
  const casesText = await readFile(casesPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(casesText);
  } catch {
    throw new Error("Invalid routing eval case set JSON");
  }
  const cases = validateCaseSet(parsed);
  const casesSha256 = createHash("sha256").update(casesText).digest("hex");
  const routingCodeSha256 = createHash("sha256")
    .update("routing.ts\0")
    .update(await readFile(path.join(process.cwd(), "src", "routing.ts")))
    .update("\0replay.ts\0")
    .update(await readFile(path.join(process.cwd(), "src", "replay.ts")))
    .digest("hex");
  const report = await runRoutingEval(cases, casesSha256, routingCodeSha256);
  const reportPath = await saveRoutingEvalReport(report);
  console.log(`Saved routing eval report: ${reportPath}`);
  console.log(JSON.stringify({ summary: report.summary, failures: report.results.filter((result) => !result.pass) }));
  if (report.summary.failed > 0) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Routing eval failed");
    process.exitCode = 1;
  });
}

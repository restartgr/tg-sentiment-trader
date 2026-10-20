import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ReplaySnapshot } from "./replay-snapshot";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isUnitNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

export function isReplayInput(value: unknown): value is ReplaySnapshot["input"] {
  return isRecord(value) &&
    typeof value.quickScore === "number" &&
    Number.isFinite(value.quickScore) &&
    value.quickScore >= -1 &&
    value.quickScore <= 1 &&
    isUnitNumber(value.quickHeat);
}

export function isReplayThresholds(value: unknown): value is { scoreMin: number; heatDeepMin: number } {
  return isRecord(value) && isUnitNumber(value.scoreMin) && isUnitNumber(value.heatDeepMin);
}

export function validateReplaySnapshot(value: unknown): ReplaySnapshot {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.batchId) ||
    (value.batchId as number) < 1 ||
    !isReplayInput(value.input) ||
    !isRecord(value.historicalResult) ||
    value.historicalResult.status !== "completed" ||
    typeof value.historicalResult.tier !== "string" ||
    value.historicalResult.tier.length === 0
  ) {
    throw new Error("Invalid replay snapshot");
  }
  return value as unknown as ReplaySnapshot;
}

export async function loadReplaySnapshotFile(batchId: number): Promise<{
  snapshot: ReplaySnapshot;
  snapshotSha256: string;
}> {
  if (!Number.isSafeInteger(batchId) || batchId < 1) throw new Error("Invalid batch ID");
  const snapshotPath = path.join(process.cwd(), "data", "replay", "fixtures", `batch-${batchId}.json`);
  const snapshotText = await readFile(snapshotPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshotText);
  } catch {
    throw new Error(`Invalid replay snapshot JSON: batch ${batchId}`);
  }
  const snapshot = validateReplaySnapshot(parsed);
  if (snapshot.batchId !== batchId) throw new Error(`Snapshot batch ID mismatch: ${batchId}`);
  return {
    snapshot,
    snapshotSha256: createHash("sha256").update(snapshotText).digest("hex"),
  };
}

export async function saveJsonReport(reportPath: string, report: unknown): Promise<string> {
  await mkdir(path.dirname(reportPath), { recursive: true, mode: 0o700 });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return reportPath;
}

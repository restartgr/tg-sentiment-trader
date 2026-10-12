import Database from "better-sqlite3";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export interface ReplaySnapshot {
  schemaVersion: 1;
  batchId: number;
  input: {
    quickScore: number;
    quickHeat: number;
  };
  historicalResult: {
    status: "completed";
    tier: string;
  };
}

interface BatchRow {
  id: number;
  status: string;
  quickScore: number | null;
  finalTier: string | null;
  resultJson: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readReplaySnapshot(
  batchId: number,
  dbFile = path.join(process.cwd(), "data", "tg-sentiment.db"),
): ReplaySnapshot {
  if (!Number.isSafeInteger(batchId) || batchId < 1) {
    throw new Error("Batch ID must be a positive integer");
  }

  // Opening the existing database read-only avoids initDatabase's schema and WAL writes.
  const db = new Database(dbFile, { readonly: true, fileMustExist: true });
  try {
    const row = db
      .prepare(
        `SELECT id, status, quick_score AS quickScore,
                final_tier AS finalTier, result_json AS resultJson
         FROM batches WHERE id = ?`,
      )
      .get(batchId) as BatchRow | undefined;

    if (!row) throw new Error(`Batch ${batchId} does not exist`);
    if (row.status !== "completed") {
      throw new Error(`Batch ${batchId} is not completed`);
    }

    let storedResult: unknown;
    try {
      storedResult = JSON.parse(row.resultJson);
    } catch {
      throw new Error(`Batch ${batchId} has invalid stored result JSON`);
    }
    const quick = isRecord(storedResult) ? storedResult.quick : undefined;
    const quickScore = row.quickScore;
    const quickHeat = isRecord(quick) ? quick.heat : undefined;
    if (
      typeof quickScore !== "number" ||
      !Number.isFinite(quickScore) ||
      quickScore < -1 ||
      quickScore > 1 ||
      typeof quickHeat !== "number" ||
      !Number.isFinite(quickHeat) ||
      quickHeat < 0 ||
      quickHeat > 1 ||
      !row.finalTier
    ) {
      throw new Error(`Batch ${batchId} has incomplete replay input`);
    }
    if (isRecord(quick) && quick.score !== quickScore) {
      throw new Error(`Batch ${batchId} has inconsistent quick score`);
    }

    return {
      schemaVersion: 1,
      batchId: row.id,
      input: { quickScore, quickHeat },
      historicalResult: { status: "completed", tier: row.finalTier },
    };
  } finally {
    db.close();
  }
}

export async function saveReplaySnapshot(
  snapshot: ReplaySnapshot,
  snapshotDir = path.join(process.cwd(), "data", "replay", "fixtures"),
): Promise<string> {
  await mkdir(snapshotDir, { recursive: true, mode: 0o700 });
  const snapshotPath = path.join(snapshotDir, `batch-${snapshot.batchId}.json`);
  await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return snapshotPath;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--batch" || !/^\d+$/.test(args[1])) {
    throw new Error("Usage: pnpm replay:snapshot --batch <positive integer>");
  }
  const snapshot = readReplaySnapshot(Number(args[1]));
  const snapshotPath = await saveReplaySnapshot(snapshot);
  console.log(`Saved replay snapshot: ${snapshotPath}`);
  console.log(JSON.stringify(snapshot));
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Snapshot failed");
    process.exitCode = 1;
  });
}

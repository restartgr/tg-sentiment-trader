import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { closeDatabase, initDatabase, saveBatch, saveMessage } from "./db";
import { readReplaySnapshot, saveReplaySnapshot } from "./replay-snapshot";

async function main(): Promise<void> {
  const testDir = await mkdtemp(path.join(tmpdir(), "tg-replay-snapshot-"));
  const dbFile = path.join(testDir, "test.db");
  const snapshotDir = path.join(testDir, "fixtures");
  try {
    initDatabase(dbFile);
    let batchId: number;
    let incompleteBatchId: number;
    try {
      const messageId = saveMessage({
        tgMessageId: 1,
        groupId: "test",
        senderId: null,
        username: "test",
        text: "private message",
        messageTs: 1,
      });
      const base = {
        groupId: "test",
        messageIds: [messageId],
        startTime: 1,
        endTime: 2,
        finalScore: null,
        initialTier: null,
        finalTier: "quick",
        dominantEmotion: "",
        summary: "private summary",
        marketInsight: "",
        status: "completed" as const,
      };
      batchId = saveBatch({
        ...base,
        quickScore: -0.3,
        result: {
          quick: { score: -0.3, heat: 0.45, comment: "private message" },
          analysis: { summary: "private summary" },
        },
      });
      incompleteBatchId = saveBatch({
        ...base,
        quickScore: 0.4,
        result: { quick: { score: 0.4 } },
      });
    } finally {
      closeDatabase();
    }

    const snapshot = readReplaySnapshot(batchId, dbFile);
    assert.deepEqual(snapshot, {
      schemaVersion: 1,
      batchId,
      input: { quickScore: -0.3, quickHeat: 0.45 },
      historicalResult: { status: "completed", tier: "quick" },
    });
    const snapshotPath = await saveReplaySnapshot(snapshot, snapshotDir);
    const saved = await readFile(snapshotPath, "utf8");
    assert.deepEqual(JSON.parse(saved), snapshot);
    assert.equal(saved.includes("private message"), false);
    assert.equal(saved.includes("private summary"), false);
    assert.equal((await stat(snapshotPath)).mode & 0o777, 0o600);
    await assert.rejects(saveReplaySnapshot(snapshot, snapshotDir), {
      code: "EEXIST",
    });
    assert.throws(() => readReplaySnapshot(incompleteBatchId, dbFile), /incomplete replay input/);
    assert.throws(() => readReplaySnapshot(999, dbFile), /does not exist/);

    const absentFile = path.join(testDir, "absent.db");
    assert.throws(() => readReplaySnapshot(batchId, absentFile));
    await assert.rejects(stat(absentFile), { code: "ENOENT" });
    console.log("✓ read-only replay snapshot: minimal fields, validation, no overwrite");
  } finally {
    await rm(testDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

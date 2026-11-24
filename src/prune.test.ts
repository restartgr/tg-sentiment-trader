import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { test } from "node:test";
import { initDatabase } from "./db";
import { parsePruneArgs, pruneDatabase } from "./prune";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 25, 3, 0); // 2026-11-25 12:00 JST

test("parsePruneArgs 默认保留 6 个月并校验参数", () => {
  const options = parsePruneArgs([]);
  assert.equal(options.months, 6);
  assert.equal(options.archiveRetentionMonths, 12);
  assert.equal(options.dryRun, false);
  assert.equal(parsePruneArgs(["--months", "3", "--dry-run"]).months, 3);
  assert.throws(() => parsePruneArgs(["--months", "0"]));
  assert.throws(() => parsePruneArgs(["--foo"]));
});

test("pruneDatabase 归档并删除旧数据，保留跨截止线批次的来源消息", () => {
  const db = initDatabase(":memory:");
  const archiveDir = fs.mkdtempSync(path.join(os.tmpdir(), "prune-test-"));

  const insertMessage = db.prepare(
    "INSERT INTO messages (tg_message_id, group_id, sender_id, username, text, message_ts) VALUES (?, 'g', 's', 'u', ?, ?)",
  );
  const insertBatch = db.prepare(
    "INSERT INTO batches (group_id, start_time, end_time, result_json, status) VALUES ('g', ?, ?, '{}', 'completed')",
  );
  const link = db.prepare("INSERT INTO batch_messages (batch_id, message_id, position) VALUES (?, ?, ?)");

  const old = NOW - 300 * DAY; // 约 10 个月前
  const edge = NOW - 183 * DAY - 60_000; // 刚过 6 个月截止线
  const recent = NOW - 10 * DAY;

  const mOld = Number(insertMessage.run(1, "old", old).lastInsertRowid);
  const mOrphan = Number(insertMessage.run(2, "orphan", old).lastInsertRowid);
  const mEdge = Number(insertMessage.run(3, "edge", edge).lastInsertRowid);
  const mRecent = Number(insertMessage.run(4, "recent", recent).lastInsertRowid);

  const bOld = Number(insertBatch.run(old, old).lastInsertRowid);
  link.run(bOld, mOld, 0);
  // 跨截止线：开始于截止前、结束于截止后，应整批保留，连同截止前的来源消息。
  const bSpan = Number(insertBatch.run(edge, recent).lastInsertRowid);
  link.run(bSpan, mEdge, 0);
  link.run(bSpan, mRecent, 1);

  const options = { ...parsePruneArgs([]), archiveDir };

  const preview = pruneDatabase(db, { ...options, dryRun: true }, NOW);
  assert.deepEqual(
    { batches: preview.batches, batchMessages: preview.batchMessages, messages: preview.messages },
    { batches: 1, batchMessages: 1, messages: 2 },
  );
  assert.equal(preview.archiveFile, null);
  assert.equal((db.prepare("SELECT COUNT(*) c FROM messages").get() as { c: number }).c, 4);

  const result = pruneDatabase(db, options, NOW);
  assert.ok(result.archiveFile && fs.existsSync(result.archiveFile));

  const remainingMessages = (db.prepare("SELECT id FROM messages ORDER BY id").all() as { id: number }[]).map((r) => r.id);
  assert.deepEqual(remainingMessages, [mEdge, mRecent]);
  const remainingBatches = (db.prepare("SELECT id FROM batches").all() as { id: number }[]).map((r) => r.id);
  assert.deepEqual(remainingBatches, [bSpan]);
  assert.equal((db.prepare("SELECT COUNT(*) c FROM batch_messages").get() as { c: number }).c, 2);

  const archived = zlib
    .gunzipSync(fs.readFileSync(result.archiveFile!))
    .toString()
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    archived.map((entry) => entry.table),
    ["batches", "batch_messages", "messages", "messages"],
  );
  assert.deepEqual(
    archived.filter((e) => e.table === "messages").map((e) => e.row.text),
    ["old", "orphan"],
  );

  // 过期归档会被清掉，新归档保留。
  const expired = path.join(archiveDir, "prune-20250101-000000-before-20240701.jsonl.gz");
  fs.writeFileSync(expired, "");
  const oldTime = new Date(NOW - 400 * DAY);
  fs.utimesSync(expired, oldTime, oldTime);
  const second = pruneDatabase(db, options, NOW);
  assert.equal(second.archiveFile, null);
  assert.deepEqual(second.removedArchives, [path.basename(expired)]);
  assert.ok(fs.existsSync(result.archiveFile!));
});

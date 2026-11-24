import type Database from "better-sqlite3";
import dayjs from "dayjs";
import fs from "fs";
import path from "path";
import zlib from "zlib";
import { initDatabase } from "./db";

export interface PruneOptions {
  months: number; // 保留最近几个月
  archiveDir: string;
  archiveRetentionMonths: number; // 归档文件保留几个月
  dryRun: boolean;
}

export interface PruneResult {
  cutoffMs: number;
  batches: number;
  batchMessages: number;
  messages: number;
  archiveFile: string | null;
  removedArchives: string[];
}

export function parsePruneArgs(argv: string[]): PruneOptions {
  const options: PruneOptions = {
    months: 6,
    archiveDir: path.join(process.cwd(), "data", "archive"),
    archiveRetentionMonths: 12,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--months") options.months = positiveInt(argv[++i], arg);
    else if (arg === "--archive-months") options.archiveRetentionMonths = positiveInt(argv[++i], arg);
    else if (arg === "--archive-dir") options.archiveDir = argv[++i] ?? "";
    else throw new Error(`未知参数：${arg}（可用：--months N --archive-months N --archive-dir DIR --dry-run）`);
  }
  return options;
}

function positiveInt(value: string | undefined, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} 需要正整数，收到：${value}`);
  return n;
}

// 旧数据的判定：批次按 end_time；消息按 message_ts，且不再被任何保留批次引用，
// 避免跨越截止线的批次在详情里丢失来源消息。
function selectOldRows(db: Database.Database, cutoffMs: number) {
  const batches = db.prepare("SELECT * FROM batches WHERE end_time < ? ORDER BY id").all(cutoffMs);
  const batchMessages = db
    .prepare(
      `SELECT bm.* FROM batch_messages bm
       JOIN batches b ON b.id = bm.batch_id
       WHERE b.end_time < ? ORDER BY bm.batch_id, bm.position`,
    )
    .all(cutoffMs);
  const messages = db
    .prepare(
      `SELECT * FROM messages
       WHERE message_ts < ?
         AND id NOT IN (
           SELECT bm.message_id FROM batch_messages bm
           JOIN batches b ON b.id = bm.batch_id
           WHERE b.end_time >= ?
         )
       ORDER BY id`,
    )
    .all(cutoffMs, cutoffMs);
  return { batches, batchMessages, messages };
}

function writeArchive(
  archiveDir: string,
  cutoffMs: number,
  rows: ReturnType<typeof selectOldRows>,
): string {
  fs.mkdirSync(archiveDir, { recursive: true });
  const file = path.join(
    archiveDir,
    `prune-${dayjs().format("YYYYMMDD-HHmmss")}-before-${dayjs(cutoffMs).format("YYYYMMDD")}.jsonl.gz`,
  );
  const lines = [
    ...rows.batches.map((row) => JSON.stringify({ table: "batches", row })),
    ...rows.batchMessages.map((row) => JSON.stringify({ table: "batch_messages", row })),
    ...rows.messages.map((row) => JSON.stringify({ table: "messages", row })),
  ];
  fs.writeFileSync(file, zlib.gzipSync(lines.join("\n") + "\n"));
  return file;
}

function removeExpiredArchives(archiveDir: string, retentionMonths: number, now: number): string[] {
  if (!fs.existsSync(archiveDir)) return [];
  const expireBefore = dayjs(now).subtract(retentionMonths, "month").valueOf();
  const removed: string[] = [];
  for (const name of fs.readdirSync(archiveDir)) {
    if (!/^prune-.*\.jsonl\.gz$/.test(name)) continue;
    const file = path.join(archiveDir, name);
    if (fs.statSync(file).mtimeMs < expireBefore) {
      fs.unlinkSync(file);
      removed.push(name);
    }
  }
  return removed;
}

export function pruneDatabase(
  db: Database.Database,
  options: PruneOptions,
  now = Date.now(),
): PruneResult {
  const cutoffMs = dayjs(now).subtract(options.months, "month").valueOf();
  const rows = selectOldRows(db, cutoffMs);
  const result: PruneResult = {
    cutoffMs,
    batches: rows.batches.length,
    batchMessages: rows.batchMessages.length,
    messages: rows.messages.length,
    archiveFile: null,
    removedArchives: [],
  };
  if (options.dryRun) return result;

  const total = rows.batches.length + rows.messages.length;
  if (total > 0) {
    // 先落归档再删除；归档失败会直接抛错，不会删任何数据。
    result.archiveFile = writeArchive(options.archiveDir, cutoffMs, rows);
    db.transaction(() => {
      // batch_messages 通过外键 ON DELETE CASCADE 随批次一起删除。
      db.prepare("DELETE FROM batches WHERE end_time < ?").run(cutoffMs);
      const deleteMessage = db.prepare("DELETE FROM messages WHERE id = ?");
      for (const row of rows.messages as { id: number }[]) deleteMessage.run(row.id);
    })();
  }
  result.removedArchives = removeExpiredArchives(options.archiveDir, options.archiveRetentionMonths, now);
  return result;
}

function compact(db: Database.Database): void {
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.exec("VACUUM");
}

function main(): void {
  const options = parsePruneArgs(process.argv.slice(2));
  const db = initDatabase();
  db.pragma("busy_timeout = 30000");
  const result = pruneDatabase(db, options);
  const cutoff = dayjs(result.cutoffMs).format("YYYY-MM-DD HH:mm");

  console.log(
    `${options.dryRun ? "🔍 预演" : "🧹 清理"}：保留最近 ${options.months} 个月（截止 ${cutoff} 之前）`,
  );
  console.log(`   批次 ${result.batches} 个 / 批次关联 ${result.batchMessages} 条 / 消息 ${result.messages} 条`);
  if (result.archiveFile) {
    console.log(`   📦 归档：${result.archiveFile}`);
    compact(db);
    console.log("   ✅ 已删除并压缩数据库");
  } else if (!options.dryRun) {
    console.log("   没有需要清理的数据");
  }
  for (const name of result.removedArchives) console.log(`   🗑️ 删除过期归档：${name}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error("清理失败:", error);
    process.exit(1);
  }
}

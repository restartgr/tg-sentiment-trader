import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const DEFAULT_DB_FILE = path.join(
  process.cwd(),
  "data",
  "tg-sentiment.db",
);

let database: Database.Database | null = null;

export interface MessageInput {
  tgMessageId: number;
  groupId: string;
  senderId: string | null;
  username: string;
  text: string;
  messageTs: number;
}

export interface BatchInput {
  groupId: string;
  messageIds: number[];
  startTime: number;
  endTime: number;
  quickScore: number | null;
  finalScore: number | null;
  initialTier: string | null;
  finalTier: string | null;
  dominantEmotion: string;
  summary: string;
  marketInsight: string;
  result: unknown;
  status: "completed" | "failed";
  errorMessage?: string;
}

export interface StoredMessage {
  id: number;
  tgMessageId: number;
  groupId: string;
  senderId: string | null;
  username: string;
  text: string;
  messageTs: number;
}

export interface StoredBatch {
  id: number;
  groupId: string;
  startTime: number;
  endTime: number;
  quickScore: number | null;
  finalScore: number | null;
  initialTier: string | null;
  finalTier: string | null;
  dominantEmotion: string;
  summary: string;
  marketInsight: string;
  status: "completed" | "failed";
  errorMessage: string | null;
  createdAt: string;
}

export interface MessageQuery {
  groupId?: string;
  query?: string;
  startTime?: number;
  endTime?: number;
  limit?: number;
}

export interface BatchQuery {
  groupId?: string;
  startTime?: number;
  endTime?: number;
  status?: "completed" | "failed";
  limit?: number;
}

export interface DatabaseStats {
  messages: number;
  batches: number;
  completedBatches: number;
  failedBatches: number;
  batchMessageLinks: number;
}

export function initDatabase(dbFile = DEFAULT_DB_FILE): Database.Database {
  if (database) return database;

  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  database = new Database(dbFile);
  database.pragma("foreign_keys = ON");
  database.pragma("journal_mode = WAL");

  database.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tg_message_id INTEGER NOT NULL,
      group_id TEXT NOT NULL,
      sender_id TEXT,
      username TEXT NOT NULL,
      text TEXT NOT NULL,
      message_ts INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(group_id, tg_message_id)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_group_time
      ON messages(group_id, message_ts);

    CREATE TABLE IF NOT EXISTS batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id TEXT NOT NULL,
      start_time INTEGER NOT NULL,
      end_time INTEGER NOT NULL,
      quick_score REAL,
      final_score REAL,
      initial_tier TEXT,
      final_tier TEXT,
      dominant_emotion TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      market_insight TEXT NOT NULL DEFAULT '',
      result_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('completed', 'failed')),
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_batches_group_time
      ON batches(group_id, start_time, end_time);

    CREATE TABLE IF NOT EXISTS batch_messages (
      batch_id INTEGER NOT NULL,
      message_id INTEGER NOT NULL,
      position INTEGER NOT NULL,
      PRIMARY KEY(batch_id, message_id),
      UNIQUE(batch_id, position),
      FOREIGN KEY(batch_id) REFERENCES batches(id) ON DELETE CASCADE,
      FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE
    );
  `);

  return database;
}

function getDatabase(): Database.Database {
  return database ?? initDatabase();
}

export function saveMessage(input: MessageInput): number {
  const db = getDatabase();

  db.prepare(`
    INSERT INTO messages (
      tg_message_id,
      group_id,
      sender_id,
      username,
      text,
      message_ts
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(group_id, tg_message_id) DO UPDATE SET
      sender_id = excluded.sender_id,
      username = excluded.username,
      text = excluded.text,
      message_ts = excluded.message_ts,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    input.tgMessageId,
    input.groupId,
    input.senderId,
    input.username,
    input.text,
    input.messageTs,
  );

  const row = db
    .prepare(
      "SELECT id FROM messages WHERE group_id = ? AND tg_message_id = ?",
    )
    .get(input.groupId, input.tgMessageId) as { id: number } | undefined;

  if (!row) throw new Error("消息写入数据库后无法读取 ID");
  return row.id;
}

export function hasCompletedAnalysis(messageId: number): boolean {
  const row = getDatabase()
    .prepare(`
      SELECT 1
      FROM batch_messages AS bm
      JOIN batches AS b ON b.id = bm.batch_id
      WHERE bm.message_id = ? AND b.status = 'completed'
      LIMIT 1
    `)
    .get(messageId);

  return row != null;
}

function normalizeLimit(limit: number | undefined, fallback: number): number {
  if (limit == null || !Number.isFinite(limit)) return fallback;
  return Math.max(1, Math.min(100, Math.floor(limit)));
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export function getRecentMessages(
  limit = 20,
  groupId?: string,
): StoredMessage[] {
  return searchMessages({ limit, groupId });
}

export function searchMessages(query: MessageQuery = {}): StoredMessage[] {
  const conditions: string[] = [];
  const params: Array<string | number> = [];

  if (query.groupId) {
    conditions.push("group_id = ?");
    params.push(query.groupId);
  }
  if (query.query?.trim()) {
    conditions.push("text LIKE ? ESCAPE '\\'");
    params.push(`%${escapeLike(query.query.trim())}%`);
  }
  if (query.startTime != null) {
    conditions.push("message_ts >= ?");
    params.push(query.startTime);
  }
  if (query.endTime != null) {
    conditions.push("message_ts < ?");
    params.push(query.endTime);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(normalizeLimit(query.limit, 20));

  return getDatabase()
    .prepare(`
      SELECT
        id,
        tg_message_id AS tgMessageId,
        group_id AS groupId,
        sender_id AS senderId,
        username,
        text,
        message_ts AS messageTs
      FROM messages
      ${where}
      ORDER BY message_ts DESC, id DESC
      LIMIT ?
    `)
    .all(...params) as StoredMessage[];
}

export function getBatchesInRange(query: BatchQuery = {}): StoredBatch[] {
  const conditions: string[] = [];
  const params: Array<string | number> = [];

  if (query.groupId) {
    conditions.push("group_id = ?");
    params.push(query.groupId);
  }
  if (query.startTime != null) {
    conditions.push("end_time >= ?");
    params.push(query.startTime);
  }
  if (query.endTime != null) {
    conditions.push("start_time < ?");
    params.push(query.endTime);
  }
  if (query.status) {
    conditions.push("status = ?");
    params.push(query.status);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(normalizeLimit(query.limit, 20));

  return getDatabase()
    .prepare(`
      SELECT
        id,
        group_id AS groupId,
        start_time AS startTime,
        end_time AS endTime,
        quick_score AS quickScore,
        final_score AS finalScore,
        initial_tier AS initialTier,
        final_tier AS finalTier,
        dominant_emotion AS dominantEmotion,
        summary,
        market_insight AS marketInsight,
        status,
        error_message AS errorMessage,
        created_at AS createdAt
      FROM batches
      ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `)
    .all(...params) as StoredBatch[];
}

export function getDatabaseStats(): DatabaseStats {
  const row = getDatabase()
    .prepare(`
      SELECT
        (SELECT COUNT(*) FROM messages) AS messages,
        (SELECT COUNT(*) FROM batches) AS batches,
        (SELECT COUNT(*) FROM batches WHERE status = 'completed') AS completedBatches,
        (SELECT COUNT(*) FROM batches WHERE status = 'failed') AS failedBatches,
        (SELECT COUNT(*) FROM batch_messages) AS batchMessageLinks
    `)
    .get() as DatabaseStats;

  return row;
}

export function saveBatch(input: BatchInput): number {
  if (input.messageIds.length === 0) {
    throw new Error("不能保存没有消息的 batch");
  }

  const db = getDatabase();
  const insertBatch = db.prepare(`
    INSERT INTO batches (
      group_id,
      start_time,
      end_time,
      quick_score,
      final_score,
      initial_tier,
      final_tier,
      dominant_emotion,
      summary,
      market_insight,
      result_json,
      status,
      error_message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const linkMessage = db.prepare(`
    INSERT INTO batch_messages (batch_id, message_id, position)
    VALUES (?, ?, ?)
  `);

  const insertTransaction = db.transaction(() => {
    const result = insertBatch.run(
      input.groupId,
      input.startTime,
      input.endTime,
      input.quickScore,
      input.finalScore,
      input.initialTier,
      input.finalTier,
      input.dominantEmotion,
      input.summary,
      input.marketInsight,
      JSON.stringify(input.result),
      input.status,
      input.errorMessage ?? null,
    );
    const batchId = Number(result.lastInsertRowid);

    input.messageIds.forEach((messageId, position) => {
      linkMessage.run(batchId, messageId, position);
    });

    return batchId;
  });

  return insertTransaction();
}

export function closeDatabase(): void {
  database?.close();
  database = null;
}

if (require.main === module) {
  initDatabase();
  console.log(`SQLite 数据库已初始化：${DEFAULT_DB_FILE}`);
}

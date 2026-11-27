import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const DEFAULT_DB_FILE = path.join(process.cwd(), "data", "tg-sentiment.db");

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

export function initDatabase(dbFile = process.env.TG_DB_FILE ?? DEFAULT_DB_FILE): Database.Database {
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

    -- 黑话词典自动学习：大模型认出的新叫法先记为 pending，经 bot 确认后才进词典。
    CREATE TABLE IF NOT EXISTS asset_aliases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      term TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      ticker TEXT NOT NULL,
      exchange TEXT NOT NULL,
      yahoo_symbol TEXT NOT NULL DEFAULT '',
      yahoo_name TEXT NOT NULL DEFAULT '',
      evidence TEXT NOT NULL DEFAULT '',
      group_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK(status IN ('pending', 'confirmed', 'rejected')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      decided_at TEXT
    );

    -- 每批识别到的资产提及（按 Yahoo symbol 归一），用于提及量异动。
    CREATE TABLE IF NOT EXISTS asset_mentions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      name TEXT NOT NULL,
      count INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_asset_mentions_group_ts
      ON asset_mentions(group_id, ts);

    -- 告警事后验证：每次推送记一行/标的，之后回填 1 日、5 日涨跌。
    CREATE TABLE IF NOT EXISTS alert_outcomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_ts INTEGER NOT NULL,
      group_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('sentiment', 'mention')),
      direction INTEGER NOT NULL,
      score REAL,
      heat REAL,
      label TEXT NOT NULL DEFAULT '',
      symbol TEXT NOT NULL,
      base_price REAL NOT NULL,
      context_json TEXT NOT NULL DEFAULT '{}',
      ret_1d REAL,
      ret_5d REAL,
      evaluated_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_alert_outcomes_pending
      ON alert_outcomes(ret_5d, alert_ts);
  `);

  // 迁移：asset_aliases.notified_at 记录最近一次推送确认消息的时间，用于重推过期候选。
  const aliasColumns = database.prepare("PRAGMA table_info(asset_aliases)").all() as { name: string }[];
  if (!aliasColumns.some((c) => c.name === "notified_at")) {
    database.exec("ALTER TABLE asset_aliases ADD COLUMN notified_at TEXT");
  }

  return database;
}

function getDatabase(): Database.Database {
  return database ?? initDatabase();
}

export function saveMessage(input: MessageInput): number {
  const db = getDatabase();

  db.prepare(
    `
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
  `,
  ).run(
    input.tgMessageId,
    input.groupId,
    input.senderId,
    input.username,
    input.text,
    input.messageTs,
  );

  const row = db
    .prepare("SELECT id FROM messages WHERE group_id = ? AND tg_message_id = ?")
    .get(input.groupId, input.tgMessageId) as { id: number } | undefined;

  if (!row) {
    throw new Error(
      `消息写入数据库后无法读取 ID (groupId=${input.groupId}, tgMessageId=${input.tgMessageId})`,
    );
  }
  return row.id;
}

export function hasCompletedAnalysis(messageId: number): boolean {
  const row = getDatabase()
    .prepare(
      `
      SELECT 1
      FROM batch_messages AS bm
      JOIN batches AS b ON b.id = bm.batch_id
      WHERE bm.message_id = ? AND b.status = 'completed'
      LIMIT 1
    `,
    )
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

  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(normalizeLimit(query.limit, 20));

  return getDatabase()
    .prepare(
      `
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
    `,
    )
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

  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(normalizeLimit(query.limit, 20));

  return getDatabase()
    .prepare(
      `
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
    `,
    )
    .all(...params) as StoredBatch[];
}

export function getDatabaseStats(): DatabaseStats {
  const row = getDatabase()
    .prepare(
      `
      SELECT
        (SELECT COUNT(*) FROM messages) AS messages,
        (SELECT COUNT(*) FROM batches) AS batches,
        (SELECT COUNT(*) FROM batches WHERE status = 'completed') AS completedBatches,
        (SELECT COUNT(*) FROM batches WHERE status = 'failed') AS failedBatches,
        (SELECT COUNT(*) FROM batch_messages) AS batchMessageLinks
    `,
    )
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

export function getBatchById(batchId: number): StoredBatch | null {
  const row = getDatabase()
    .prepare(
      `
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
      WHERE id = ?
    `,
    )
    .get(batchId) as StoredBatch | undefined;

  return row ?? null;
}

export function getBatchResultById(batchId: number): unknown | null {
  const row = getDatabase()
    .prepare("SELECT result_json AS resultJson FROM batches WHERE id = ?")
    .get(batchId) as { resultJson: string } | undefined;
  return row ? JSON.parse(row.resultJson) as unknown : null;
}

export function getBatchMessageCount(batchId: number): number {
  const row = getDatabase()
    .prepare("SELECT COUNT(*) AS count FROM batch_messages WHERE batch_id = ?")
    .get(batchId) as { count: number };

  return row.count;
}

export function getBatchMessages(
  batchId: number,
  limit?: number,
): StoredMessage[] {
  return getDatabase()
    .prepare(
      `
      SELECT
        m.id,
        m.tg_message_id AS tgMessageId,
        m.group_id AS groupId,
        m.sender_id AS senderId,
        m.username,
        m.text,
        m.message_ts AS messageTs
      FROM batch_messages AS bm
      JOIN messages AS m ON m.id = bm.message_id
      WHERE bm.batch_id = ?
      ORDER BY bm.position ASC
      LIMIT ?
    `,
    )
    .all(batchId, normalizeLimit(limit, 20)) as StoredMessage[];
}

export type AliasStatus = "pending" | "confirmed" | "rejected";

export interface AliasCandidateInput {
  term: string;
  name: string;
  ticker: string;
  exchange: string;
  yahooSymbol: string;
  yahooName: string;
  evidence: string;
  groupId: string;
}

export interface StoredAlias extends AliasCandidateInput {
  id: number;
  status: AliasStatus;
}

// 已存在同名 term（任何状态）返回 null，避免重复提醒或推翻已做的决定。
export function insertAliasCandidate(input: AliasCandidateInput): number | null {
  const result = getDatabase()
    .prepare(
      `INSERT OR IGNORE INTO asset_aliases
        (term, name, ticker, exchange, yahoo_symbol, yahoo_name, evidence, group_id, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    )
    .run(
      input.term,
      input.name,
      input.ticker,
      input.exchange,
      input.yahooSymbol,
      input.yahooName,
      input.evidence,
      input.groupId,
    );
  return result.changes > 0 ? Number(result.lastInsertRowid) : null;
}

function rowToAlias(row: any): StoredAlias {
  return {
    id: row.id,
    term: row.term,
    name: row.name,
    ticker: row.ticker,
    exchange: row.exchange,
    yahooSymbol: row.yahoo_symbol,
    yahooName: row.yahoo_name,
    evidence: row.evidence,
    groupId: row.group_id,
    status: row.status,
  };
}

export function listAliases(status?: AliasStatus): StoredAlias[] {
  const db = getDatabase();
  const rows = status
    ? db.prepare("SELECT * FROM asset_aliases WHERE status = ? ORDER BY id").all(status)
    : db.prepare("SELECT * FROM asset_aliases ORDER BY id").all();
  return rows.map(rowToAlias);
}

export function markAliasNotified(id: number): void {
  getDatabase()
    .prepare("UPDATE asset_aliases SET notified_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(id);
}

// 仍是 pending、且上次推送已超过 hours 小时的候选。Telegram 只保留 24 小时内的按钮点击，
// 超时的点击已经丢了，需要重新推一条带按钮的消息。
export function listStalePendingAliases(hours = 24): StoredAlias[] {
  return getDatabase()
    .prepare(
      `SELECT * FROM asset_aliases
       WHERE status = 'pending'
         AND COALESCE(notified_at, created_at) <= datetime('now', ?)
       ORDER BY id`,
    )
    .all(`-${hours} hours`)
    .map(rowToAlias);
}

// 只允许 pending → confirmed/rejected，重复点按钮不会改写已做的决定。
export function decideAlias(id: number, status: "confirmed" | "rejected"): StoredAlias | null {
  const db = getDatabase();
  db.prepare(
    `UPDATE asset_aliases SET status = ?, decided_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status = 'pending'`,
  ).run(status, id);
  const row = db.prepare("SELECT * FROM asset_aliases WHERE id = ?").get(id);
  return row ? rowToAlias(row) : null;
}

export interface MentionRow {
  groupId: string;
  ts: number;
  symbol: string;
  name: string;
  count: number;
}

export function saveMentions(rows: MentionRow[]): void {
  if (rows.length === 0) return;
  const db = getDatabase();
  const stmt = db.prepare(
    "INSERT INTO asset_mentions (group_id, ts, symbol, name, count) VALUES (?, ?, ?, ?, ?)",
  );
  db.transaction(() => {
    for (const r of rows) stmt.run(r.groupId, r.ts, r.symbol, r.name, r.count);
  })();
}

export function sumMentionsBySymbol(
  groupId: string,
  fromTs: number,
  toTs: number,
): Map<string, { count: number; name: string }> {
  const rows = getDatabase()
    .prepare(
      `SELECT symbol, MAX(name) AS name, SUM(count) AS total FROM asset_mentions
       WHERE group_id = ? AND ts >= ? AND ts < ? GROUP BY symbol`,
    )
    .all(groupId, fromTs, toTs) as { symbol: string; name: string; total: number }[];
  return new Map(rows.map((r) => [r.symbol, { count: r.total, name: r.name }]));
}

export function earliestMentionTs(groupId: string): number | null {
  const row = getDatabase()
    .prepare("SELECT MIN(ts) AS ts FROM asset_mentions WHERE group_id = ?")
    .get(groupId) as { ts: number | null };
  return row.ts;
}

// 有消息的时间窗个数：基线按"群里有人说话的时段"平均，不被夜间空白稀释。
export function countActiveWindows(
  groupId: string,
  fromTs: number,
  toTs: number,
  windowMs: number,
): number {
  const row = getDatabase()
    .prepare(
      `SELECT COUNT(DISTINCT message_ts / ?) AS n FROM messages
       WHERE group_id = ? AND message_ts >= ? AND message_ts < ?`,
    )
    .get(windowMs, groupId, fromTs, toTs) as { n: number };
  return row.n;
}

export interface AlertOutcomeInput {
  alertTs: number;
  groupId: string;
  kind: "sentiment" | "mention";
  direction: number;
  score: number | null;
  heat: number | null;
  label: string;
  symbol: string;
  basePrice: number;
  context: unknown;
}

export interface StoredAlertOutcome extends Omit<AlertOutcomeInput, "context"> {
  id: number;
  context: unknown;
  ret1d: number | null;
  ret5d: number | null;
  evaluatedAt: number | null;
}

export function saveAlertOutcome(input: AlertOutcomeInput): number {
  const result = getDatabase()
    .prepare(
      `INSERT INTO alert_outcomes
        (alert_ts, group_id, kind, direction, score, heat, label, symbol, base_price, context_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.alertTs,
      input.groupId,
      input.kind,
      input.direction,
      input.score,
      input.heat,
      input.label,
      input.symbol,
      input.basePrice,
      JSON.stringify(input.context ?? {}),
    );
  return Number(result.lastInsertRowid);
}

function rowToOutcome(row: any): StoredAlertOutcome {
  let context: unknown = {};
  try {
    context = JSON.parse(row.context_json);
  } catch {
    context = {};
  }
  return {
    id: row.id,
    alertTs: row.alert_ts,
    groupId: row.group_id,
    kind: row.kind,
    direction: row.direction,
    score: row.score,
    heat: row.heat,
    label: row.label,
    symbol: row.symbol,
    basePrice: row.base_price,
    context,
    ret1d: row.ret_1d,
    ret5d: row.ret_5d,
    evaluatedAt: row.evaluated_at,
  };
}

// 只回填 [sinceTs, beforeTs) 内的：太老还没数据的（停牌/代码失效）不再反复去拉。
export function listPendingOutcomes(sinceTs: number, beforeTs: number): StoredAlertOutcome[] {
  return getDatabase()
    .prepare(
      "SELECT * FROM alert_outcomes WHERE ret_5d IS NULL AND alert_ts >= ? AND alert_ts < ? ORDER BY id",
    )
    .all(sinceTs, beforeTs)
    .map(rowToOutcome);
}

export function updateOutcomeReturns(id: number, ret1d: number | null, ret5d: number | null): void {
  getDatabase()
    .prepare(
      `UPDATE alert_outcomes SET ret_1d = COALESCE(?, ret_1d), ret_5d = ?, evaluated_at = ?
       WHERE id = ?`,
    )
    .run(ret1d, ret5d, Date.now(), id);
}

export function listOutcomes(limit = 500): StoredAlertOutcome[] {
  return getDatabase()
    .prepare("SELECT * FROM alert_outcomes ORDER BY alert_ts DESC LIMIT ?")
    .all(limit)
    .map(rowToOutcome);
}

export function closeDatabase(): void {
  database?.close();
  database = null;
}

if (require.main === module) {
  initDatabase();
  console.log(`SQLite 数据库已初始化：${DEFAULT_DB_FILE}`);
}

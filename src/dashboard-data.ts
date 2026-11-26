import {
  getBatchById,
  getBatchMessageCount,
  getBatchMessages,
  getBatchResultById,
  getBatchesInRange,
  getDatabaseStats,
  listOutcomes,
  type StoredBatch,
} from "./db";
import { summarizeOutcomes } from "./market-signals";

type Analysis = { heat?: unknown; hotTopics?: unknown };
type StoredResult = { quick?: Analysis; analysis?: Analysis };

function metrics(batchId: number) {
  const result = getBatchResultById(batchId) as StoredResult | null;
  const heat = result?.analysis?.heat ?? result?.quick?.heat;
  const hotTopics = result?.analysis?.hotTopics;
  return {
    heat: typeof heat === "number" && Number.isFinite(heat) ? heat : null,
    hotTopics: Array.isArray(hotTopics) ? hotTopics.filter((topic): topic is string => typeof topic === "string") : [],
  };
}

function displayBatch(batch: StoredBatch) {
  return { ...batch, ...metrics(batch.id) };
}

export function listDashboardBatches(limit = 50) {
  return {
    stats: getDatabaseStats(),
    batches: getBatchesInRange({ limit }).map(displayBatch),
  };
}

export function getDashboardBatch(batchId: number) {
  const batch = getBatchById(batchId);
  if (!batch) return null;
  return {
    batch: displayBatch(batch),
    messageCount: getBatchMessageCount(batchId),
    messages: getBatchMessages(batchId, 100),
  };
}

// 告警事后验证：按类型/方向汇总 + 最近明细。
export function getOutcomeSummary(limit = 500) {
  const rows = listOutcomes(limit);
  return {
    stats: summarizeOutcomes(rows),
    recent: rows.slice(0, 30).map(({ context: _context, ...row }) => row),
  };
}

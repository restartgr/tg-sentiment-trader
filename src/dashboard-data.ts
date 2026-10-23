import {
  getBatchById,
  getBatchMessageCount,
  getBatchMessages,
  getBatchResultById,
  getBatchesInRange,
  getDatabaseStats,
  type StoredBatch,
} from "./db";

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

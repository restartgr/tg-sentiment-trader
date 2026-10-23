import { requestJson } from "./client";
import type {
  AgentAnswer,
  Batch,
  BatchDetail,
  CostSummary,
  RunTrace,
  Stats,
} from "./types";

// 每个接口一个函数：组件只关心拿到什么数据，不拼 URL
export function fetchStats(signal: AbortSignal) {
  return requestJson<Stats>("/api/stats", { signal });
}

export async function fetchBatches(limit: number, signal: AbortSignal) {
  const result = await requestJson<{ batches: Batch[] }>(
    `/api/batches?limit=${limit}`,
    { signal },
  );
  return Array.isArray(result.batches) ? result.batches : [];
}

export function fetchBatchDetail(id: number, signal: AbortSignal) {
  return requestJson<BatchDetail>(`/api/batches/${id}`, { signal });
}

export function fetchCostSummary(limit: number, signal: AbortSignal) {
  return requestJson<CostSummary>(`/api/costs?limit=${limit}`, { signal });
}

export function fetchRunTrace(runId: string, signal: AbortSignal) {
  return requestJson<RunTrace>(`/api/runs/${runId}`, { signal });
}

export function askAgent(question: string, signal: AbortSignal) {
  return requestJson<AgentAnswer>("/api/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question }),
    signal,
  });
}

import { useCallback, useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  askAgent,
  fetchBatchDetail,
  fetchBatches,
  fetchCostSummary,
  fetchRunTrace,
  fetchStats,
} from "../api/dashboard";

export const BATCH_LIMIT = 50;
export const COST_RUN_LIMIT = 20;

export const queryKeys = {
  stats: ["stats"] as const,
  batches: (limit: number) => ["batches", limit] as const,
  batch: (id: number) => ["batch", id] as const,
  costs: (limit: number) => ["costs", limit] as const,
  run: (runId: string) => ["run", runId] as const,
};

// queryFn 拿到的 signal 会在组件卸载或查询被取代时自动 abort
export function useStats() {
  return useQuery({
    queryKey: queryKeys.stats,
    queryFn: ({ signal }) => fetchStats(signal),
  });
}

export function useBatches(limit = BATCH_LIMIT) {
  return useQuery({
    queryKey: queryKeys.batches(limit),
    queryFn: ({ signal }) => fetchBatches(limit, signal),
  });
}

export function useBatchDetail(id: number) {
  return useQuery({
    queryKey: queryKeys.batch(id),
    queryFn: ({ signal }) => fetchBatchDetail(id, signal),
  });
}

export function useCostSummary(limit = COST_RUN_LIMIT) {
  return useQuery({
    queryKey: queryKeys.costs(limit),
    queryFn: ({ signal }) => fetchCostSummary(limit, signal),
  });
}

export function useRunTrace(runId: string) {
  return useQuery({
    queryKey: queryKeys.run(runId),
    queryFn: ({ signal }) => fetchRunTrace(runId, signal),
    // 同一次运行的 trace 写完就不会再变
    staleTime: Infinity,
  });
}

export function useAskAgent() {
  const queryClient = useQueryClient();
  const controllerRef = useRef<AbortController | null>(null);

  const mutation = useMutation({
    mutationFn: (question: string) => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      return askAgent(question, controller.signal);
    },
    // 每次问答都会产生新费用，成本汇总需要重新统计
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["costs"] }),
  });

  const cancel = useCallback(() => controllerRef.current?.abort(), []);

  // 离开页面时不让后端继续跑一个没人看的 Agent
  useEffect(() => () => controllerRef.current?.abort(), []);

  return { ...mutation, cancel };
}

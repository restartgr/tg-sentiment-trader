export interface Stats {
  messages: number;
  batches: number;
  completedBatches: number;
  failedBatches: number;
}

export interface Batch {
  id: number;
  groupId: string;
  startTime: number;
  endTime: number;
  quickScore: number | null;
  finalScore: number | null;
  heat: number | null;
  hotTopics: string[];
  summary: string;
  marketInsight: string;
  status: "completed" | "failed";
}

export interface SourceMessage {
  id: number;
  username: string;
  text: string;
  messageTs: number;
}

export interface BatchDetail {
  batch: Batch;
  messageCount: number;
  messages: SourceMessage[];
}

export interface AgentAnswer {
  runId: string;
  answer: string;
  estimatedCostUsd: number | null;
  inspectedBatches: Array<{ id: number; summary: string; url: string }>;
}

export interface RunTrace {
  runId: string;
  events: Array<{ eventType: "model_call" | "tool_call"; status: "success" | "error" }>;
}

export async function requestJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new Error(`接口没有返回 JSON（HTTP ${response.status}）`);
  }
  if (!response.ok) {
    const message = data && typeof data === "object" && "error" in data && typeof data.error === "string"
      ? data.error
      : `请求失败（HTTP ${response.status}）`;
    throw new Error(message);
  }
  return data as T;
}

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

export interface CostSummary {
  runs: number;
  knownRuns: number;
  unknownRuns: number;
  totalCostUsd: number;
  averageCostUsd: number | null;
}

export interface InspectedBatch {
  id: number;
  summary: string;
  url: string;
}

export interface AgentAnswer {
  runId: string;
  answer: string;
  estimatedCostUsd: number | null;
  inspectedBatches: InspectedBatch[];
}

export interface TraceEvent {
  eventType: "model_call" | "tool_call";
  status: "success" | "error";
}

export interface RunTrace {
  runId: string;
  events: TraceEvent[];
}

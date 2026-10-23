import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export type TraceStatus = "success" | "error";

export const MODEL_PRICING_AS_OF = "2026-10-05";

export type ModelTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
};

type TraceBase = {
  runId: string;
  step: number;
  finishedAt: string;
  latencyMs: number;
  status: TraceStatus;
  errorType?: string;
  errorCode?: number | string;
  errorMessage?: string;
  httpStatus?: number;
  requestId?: string;
};

export type ErrorDetails = Pick<
  TraceBase,
  "errorType" | "errorCode" | "errorMessage" | "httpStatus" | "requestId"
>;

// 原始报错可能带回少量请求内容；排查只需要开头那句原因
const MAX_ERROR_MESSAGE_LENGTH = 200;

function truncateErrorMessage(message: string): string {
  return message.length > MAX_ERROR_MESSAGE_LENGTH
    ? `${message.slice(0, MAX_ERROR_MESSAGE_LENGTH)}…`
    : message;
}

// 按字段识别 OpenAI APIError、MCP 错误等，不依赖具体 SDK 的类
export function describeError(
  error: unknown,
  signal?: AbortSignal,
): ErrorDetails {
  // 取消的原因不一定是 Error：Hono 在客户端断开时传的是字符串
  if (signal?.aborted) {
    return {
      errorType: "Cancelled",
      errorMessage: "Request cancelled by client",
    };
  }
  if (!(error instanceof Error)) {
    return {
      errorType: "UnknownError",
      errorMessage: truncateErrorMessage(String(error)),
    };
  }

  const fields = error as Error & {
    status?: unknown;
    code?: unknown;
    type?: unknown;
    requestID?: unknown;
  };
  const code = fields.code;
  return {
    // OpenAI 的 error.name 只是 "Error"，type 才说明错误类别
    errorType: typeof fields.type === "string" ? fields.type : error.name,
    ...(typeof code === "string" || typeof code === "number"
      ? { errorCode: code }
      : {}),
    ...(typeof fields.status === "number" ? { httpStatus: fields.status } : {}),
    ...(typeof fields.requestID === "string"
      ? { requestId: fields.requestID }
      : {}),
    errorMessage: truncateErrorMessage(error.message),
  };
}

type ToolContentBlock = { type: string; text?: string };

export function toolResultText(content: readonly ToolContentBlock[]): string {
  return content
    .flatMap((item) =>
      item.type === "text" && typeof item.text === "string" ? [item.text] : [],
    )
    .join("\n");
}

export function describeToolError(text: string): {
  errorType: string;
  errorCode?: number;
  errorMessage: string;
} {
  const validation = /^MCP error\s+(-?\d+):\s*Input validation error:/i.exec(
    text,
  );
  if (validation) {
    const field = /\bat ([A-Za-z_][\w.]*)\b/.exec(text)?.[1];
    return {
      errorType: "MCPInputValidationError",
      errorCode: Number(validation[1]),
      errorMessage: field
        ? `Input validation error at ${field}`
        : "Input validation error",
    };
  }

  // This known handler error contains no request values. Unknown tool text may.
  if (text.trim() === "开始时间必须早于结束时间，请调整查询范围。") {
    return {
      errorType: "ToolReportedError",
      errorMessage: text.trim(),
    };
  }

  return {
    errorType: "ToolReportedError",
    errorMessage: "Tool reported an error; details omitted from trace",
  };
}

export type TraceEvent =
  | (TraceBase & {
      eventType: "model_call";
      model: string;
      inputTokens?: number;
      outputTokens?: number;
      cachedInputTokens?: number;
      cacheWriteInputTokens?: number;
      cacheWriteTokensAssumedZero?: boolean;
      pricingAsOf?: string;
      estimatedCostUsd?: number;
    })
  | (TraceBase & {
      eventType: "tool_call";
      toolName: string;
    });

export async function appendToolResultTrace(
  event: Pick<TraceBase, "runId" | "step" | "finishedAt" | "latencyMs"> & {
    toolName: string;
  },
  result: { isError?: boolean; content: readonly ToolContentBlock[] },
  traceDir?: string,
): Promise<string> {
  const text = toolResultText(result.content);
  const error = result.isError === true ? describeToolError(text) : undefined;
  await appendTraceEvent(
    {
      ...event,
      eventType: "tool_call",
      status: result.isError === true ? "error" : "success",
      ...error,
    },
    traceDir,
  );
  return text;
}

// Standard-tier rates per million tokens: https://developers.openai.com/api/docs/models/gpt-5.6-sol
const GPT_5_6_SOL_RATES = {
  short: { input: 4, cachedInput: 0.4, cacheWrite: 5, output: 20 },
  long: { input: 8, cachedInput: 0.8, cacheWrite: 10, output: 30 },
} as const;

export function estimateModelCostUsd(
  model: string,
  usage: ModelTokenUsage,
): number | undefined {
  if (model !== "gpt-5.6-sol") return undefined;

  const {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
  } = usage;
  if (
    ![
      inputTokens,
      outputTokens,
      cachedInputTokens,
      cacheWriteInputTokens,
    ].every((value) => Number.isSafeInteger(value) && value >= 0) ||
    cachedInputTokens + cacheWriteInputTokens > inputTokens
  ) {
    return undefined;
  }

  const rates =
    inputTokens > 272_000 ? GPT_5_6_SOL_RATES.long : GPT_5_6_SOL_RATES.short;
  const ordinaryInputTokens =
    inputTokens - cachedInputTokens - cacheWriteInputTokens;
  return (
    (ordinaryInputTokens * rates.input +
      cachedInputTokens * rates.cachedInput +
      cacheWriteInputTokens * rates.cacheWrite +
      outputTokens * rates.output) /
    1_000_000
  );
}

export async function appendTraceEvent(
  event: TraceEvent,
  traceDir = path.join(process.cwd(), "data", "traces"),
): Promise<void> {
  await mkdir(traceDir, { recursive: true, mode: 0o700 });
  await appendFile(
    path.join(traceDir, `${event.runId}.jsonl`),
    `${JSON.stringify(event)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

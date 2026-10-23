import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import path from "path";
import OpenAI from "openai";
import dotenv from "dotenv";
import {
  appendTraceEvent,
  appendToolResultTrace,
  estimateModelCostUsd,
  MODEL_PRICING_AS_OF,
} from "./agent-trace";
import { isTransientModelError, runModelRequest } from "./model-request";
import { assertInputBudget, boundedToolOutput, toolCallKey } from "./agent-loop-guards";

dotenv.config();
const MAX_STEPS = 5;
const TIME_OUT_MS = 30000;
const TOOL_TIMEOUT_MS = 15000;
const MODEL = "gpt-5.6-sol";
export interface AgentResult {
  runId: string;
  answer: string;
  estimatedCostUsd: number | null;
  inspectedBatchIds: number[];
}

export interface AgentOptions {
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

function explainedBatchId(text: string, expectedId: unknown): number | null {
  if (!Number.isInteger(expectedId) || (expectedId as number) < 1) return null;
  try {
    const result = JSON.parse(text) as { found?: unknown; batch?: { id?: unknown } };
    return result.found === true && result.batch?.id === expectedId ? expectedId as number : null;
  } catch {
    return null;
  }
}

export async function runAgent(question: string, options: AgentOptions = {}): Promise<AgentResult> {
  question = question.trim();
  if (!question) throw new Error("请提供问题");
  const { signal = new AbortController().signal, onProgress } = options;
  const client = new Client({ name: "tg-sentiment-agent", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(process.cwd(), "node_modules/tsx/dist/cli.mjs"), "src/mcp-server.ts"],
    cwd: process.cwd(),
    env: process.env.TG_DB_FILE ? { TG_DB_FILE: process.env.TG_DB_FILE } : undefined,
    stderr: "inherit",
  });
  const inspectedBatchIds = new Set<number>();
  let totalEstimatedCostUsd = 0;
  let costKnown = true;
  try {
    await client.connect(transport, { signal, timeout: TOOL_TIMEOUT_MS });
    const { tools } = await client.listTools(undefined, { signal, timeout: TOOL_TIMEOUT_MS });
    const toolsName = tools.map((item) => item.name);
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("请输入openai passkey");
    }
    const openai = new OpenAI({
      apiKey,
    });

    const functionTools: OpenAI.Responses.FunctionTool[] = tools.map(
      (tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
        type: "function",
        strict: false,
      }),
    );

    const runId = crypto.randomUUID();
    const context: OpenAI.Responses.ResponseInput = [
      {
        role: "developer",
        content: "除非用户明确指定其他时区，所有回答中的日期和时间都使用 Asia/Tokyo（JST，UTC+09:00）。工具返回的 *TimeJst 字段已完成时区转换；引用消息或批次时间时直接使用这些字段，不要自行解释原始 Unix 时间戳。",
      },
      {
        role: "user",
        content: question,
      },
    ];
    const calledTools = new Set<string>();
    for (let step = 0; step < MAX_STEPS; step++) {
      signal.throwIfAborted();
      assertInputBudget(context, functionTools);
      onProgress?.(`Agent step: ${step + 1}`);

      const modelStartedAt = performance.now();
      let response: OpenAI.Responses.Response;
      try {
        response = await runModelRequest({
          maxAttempts: 2,
          attemptTimeoutMs: TIME_OUT_MS,
          totalTimeoutMs: TIME_OUT_MS * 2 + 5_000,
          shouldRetry: isTransientModelError,
          signal,
          onRetry: async (error, nextAttempt) => {
            await appendTraceEvent({
              runId,
              step: step + 1,
              finishedAt: new Date().toISOString(),
              latencyMs: Math.round(performance.now() - modelStartedAt),
              status: "error",
              errorType: error instanceof Error ? error.name : "UnknownError",
              errorMessage: `Model request retry ${nextAttempt} scheduled`,
              eventType: "model_call",
              model: MODEL,
            });
          },
        }, ({ signal, timeoutMs }) => openai.responses.create(
          {
            model: MODEL,
            input: context,
            tools: functionTools,
            parallel_tool_calls: false,
            reasoning: {
              effort: "low",
            },
            service_tier: "default",
            store: true,
          },
          { timeout: timeoutMs, maxRetries: 0, signal },
        ));
      } catch (error) {
        await appendTraceEvent({
          runId,
          step: step + 1,
          errorMessage: "Model request failed",
          finishedAt: new Date().toISOString(),
          latencyMs: Math.round(performance.now() - modelStartedAt),
          status: "error",
          errorType: error instanceof Error ? error.name : "UnknownError",
          eventType: "model_call",
          model: MODEL,
        });
        throw error;
      }
      const usage = response.usage;
      const cacheWriteInputTokens = (
        usage?.input_tokens_details as
          | { cache_write_tokens?: number }
          | undefined
      )?.cache_write_tokens;
      const estimatedCostUsd = usage
        ? estimateModelCostUsd(response.model, {
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens,
            cachedInputTokens: usage.input_tokens_details.cached_tokens,
            cacheWriteInputTokens: cacheWriteInputTokens ?? 0,
          })
        : undefined;
      if (estimatedCostUsd === undefined) costKnown = false;
      else totalEstimatedCostUsd += estimatedCostUsd;
      await appendTraceEvent({
        runId,
        step: step + 1,
        finishedAt: new Date().toISOString(),
        latencyMs: Math.round(performance.now() - modelStartedAt),
        status: response.status === "completed" ? "success" : "error",
        ...(response.status === "completed"
          ? {}
          : { errorType: `ResponseStatus:${response.status}` }),
        errorMessage:
          response.status === "completed"
            ? undefined
            : (response.error?.code ??
              response.incomplete_details?.reason ??
              `Model response status: ${response.status}`),
        eventType: "model_call",
        model: response.model,
        inputTokens: usage?.input_tokens,
        outputTokens: usage?.output_tokens,
        cachedInputTokens: usage?.input_tokens_details.cached_tokens,
        cacheWriteInputTokens,
        cacheWriteTokensAssumedZero:
          estimatedCostUsd !== undefined && cacheWriteInputTokens === undefined
            ? true
            : undefined,
        pricingAsOf:
          estimatedCostUsd === undefined ? undefined : MODEL_PRICING_AS_OF,
        estimatedCostUsd,
      });

      if (response.status !== "completed") {
        throw new Error(`Model response status: ${response.status}`);
      }
      signal.throwIfAborted();
      for (const item of response.output) {
        if (
          item.type !== "message" &&
          item.type !== "reasoning" &&
          item.type !== "function_call"
        ) {
          throw new Error(`暂不支持的模型输出类型: ${item.type}`);
        }
        context.push(item);
      }
      const functionCall = response.output.find(
        (item): item is OpenAI.Responses.ResponseFunctionToolCall =>
          item.type === "function_call",
      );

      if (response.output.filter((item) => item.type === "function_call").length > 1) {
        throw new Error("Agent received multiple tool calls in one model step");
      }

      if (!functionCall) {
        if (!response.output_text.trim()) {
          throw new Error("Agent completed without an answer");
        }
        return {
          runId,
          answer: response.output_text.trim(),
          estimatedCostUsd: costKnown ? totalEstimatedCostUsd : null,
          inspectedBatchIds: [...inspectedBatchIds],
        };
      }

      if (!toolsName.includes(functionCall.name)) {
        throw new Error(`找不到对应的tool: ${functionCall.name}`);
      }
      if (step === MAX_STEPS - 1) {
        throw new Error(`Agent 超过最大执行步数: ${MAX_STEPS}`);
      }

      onProgress?.(`使用的 tool 名称：${functionCall.name}`);
      const toolStartedAt = performance.now();
      let toolResult: Awaited<ReturnType<Client["callTool"]>>;
      let content: Array<{ type: string; text?: string }>;
      let toolArguments: Record<string, unknown>;
      try {
        toolArguments = JSON.parse(functionCall.arguments) as Record<string, unknown>;
        const key = toolCallKey(functionCall.name, toolArguments);
        if (calledTools.has(key)) throw new Error(`Agent repeated tool call: ${functionCall.name}`);
        calledTools.add(key);
        signal.throwIfAborted();
        toolResult = await client.callTool({
          name: functionCall.name,
          arguments: toolArguments,
        }, undefined, { signal, timeout: TOOL_TIMEOUT_MS });
        signal.throwIfAborted();
        if (!Array.isArray(toolResult.content)) {
          throw new Error("MCP tool result is missing content");
        }
        content = toolResult.content;
      } catch (error) {
        await appendTraceEvent({
          runId,
          step: step + 1,
          finishedAt: new Date().toISOString(),
          errorMessage: "Tool call failed",
          latencyMs: Math.round(performance.now() - toolStartedAt),
          status: "error",
          errorType: error instanceof Error ? error.name : "UnknownError",
          eventType: "tool_call",
          toolName: functionCall.name,
        });
        throw error;
      }
      const text = await appendToolResultTrace(
        {
          runId,
          step: step + 1,
          finishedAt: new Date().toISOString(),
          latencyMs: Math.round(performance.now() - toolStartedAt),
          toolName: functionCall.name,
        },
        { isError: toolResult.isError === true, content },
      );
      if (functionCall.name === "explain_batch" && toolResult.isError !== true) {
        const batchId = explainedBatchId(text, toolArguments.batchId);
        if (batchId !== null) inspectedBatchIds.add(batchId);
      }
      const modelToolOutput = boundedToolOutput(text);
      onProgress?.(`Tool 返回 ${content.length} 项，是否报错：${toolResult.isError === true}`);
      context.push({
        type: "function_call_output",
        call_id: functionCall.call_id,
        output: modelToolOutput,
      });
    }

    throw new Error(`Agent 超过最大执行步数: ${MAX_STEPS}`);
  } finally {
    await client.close();
  }
}

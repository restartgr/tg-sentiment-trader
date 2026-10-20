import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import path from "path";
import OpenAI from "openai";
import dotenv from "dotenv";
import { APIConnectionTimeoutError } from "openai";
import {
  appendTraceEvent,
  appendToolResultTrace,
  estimateModelCostUsd,
  MODEL_PRICING_AS_OF,
} from "./agent-trace";
import { saveCapturedAnswer, type CapturedToolCall } from "./eval-answer";
import { isTransientModelError, ModelRequestTimeoutError, runModelRequest } from "./model-request";
import { assertInputBudget, boundedToolOutput, toolCallKey } from "./agent-loop-guards";

dotenv.config();
const MAX_STEPS = 5;
const TIME_OUT_MS = 30000;
const TOOL_TIMEOUT_MS = 15000;
const MODEL = "gpt-5.6-sol";
const client = new Client({
  name: "tg-sentiment-agent",
  version: "0.1.0",
});

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [
    path.join(process.cwd(), "node_modules/tsx/dist/cli.mjs"),
    "src/mcp-server.ts",
  ],
  cwd: process.cwd(),
  stderr: "inherit",
});

async function main() {
  const captureForEval = process.argv[2] === "--capture-answer-eval";
  const question = process.argv.slice(captureForEval ? 3 : 2).join(" ").trim();
  if (!question) throw new Error("请提供问题");

  const controller = new AbortController();
  const cancel = (name: string) => controller.abort(new Error(`Agent cancelled by ${name}`));
  const onSigint = () => cancel("SIGINT");
  const onSigterm = () => cancel("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  const { signal } = controller;
  console.log(`用户的问题是: ${question}`);
  // TODO 1：连接 MCP server
  try {
    await client.connect(transport, { signal, timeout: TOOL_TIMEOUT_MS });
    // TODO 2：获取 tools
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
    const capturedToolCalls: CapturedToolCall[] = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalEstimatedCostUsd = 0;
    let costKnown = true;

    const context: OpenAI.Responses.ResponseInput = [
      {
        role: "user",
        content: question,
      },
    ];
    const calledTools = new Set<string>();
    for (let step = 0; step < MAX_STEPS; step++) {
      signal.throwIfAborted();
      assertInputBudget(context, functionTools);
      console.log(`Agent step: ${step + 1}`);

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
      totalInputTokens += usage?.input_tokens ?? 0;
      totalOutputTokens += usage?.output_tokens ?? 0;
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
        console.log(`llm的结果是：${response.output_text}`);
        if (captureForEval) {
          const capturePath = await saveCapturedAnswer({
            schemaVersion: 1,
            runId,
            recordedAt: new Date().toISOString(),
            question,
            model: response.model,
            toolCalls: capturedToolCalls,
            answer: response.output_text,
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            ...(costKnown ? { estimatedCostUsd: totalEstimatedCostUsd } : {}),
          });
          console.log(`Saved answer eval case: ${capturePath}`);
        }
        return;
      }

      if (!toolsName.includes(functionCall.name)) {
        throw new Error(`找不到对应的tool: ${functionCall.name}`);
      }
      if (step === MAX_STEPS - 1) {
        throw new Error(`Agent 超过最大执行步数: ${MAX_STEPS}`);
      }

      console.log(`使用的 tool 名称：${functionCall.name}`);
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
      const modelToolOutput = boundedToolOutput(text);
      if (captureForEval) {
        capturedToolCalls.push({
          name: functionCall.name,
          arguments: toolArguments,
          isError: toolResult.isError === true,
          resultText: modelToolOutput,
        });
      }
      console.log(
        `原始结果长度：${content.length}，是否报错：${toolResult.isError}`,
      );
      context.push({
        type: "function_call_output",
        call_id: functionCall.call_id,
        output: modelToolOutput,
      });
    }

    throw new Error(`Agent 超过最大执行步数: ${MAX_STEPS}`);
  } finally {
    // TODO 4：关闭连接
    await client.close();
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }
}
const handleError = (err: unknown) => {
  if (err instanceof APIConnectionTimeoutError || err instanceof ModelRequestTimeoutError) {
    console.error("Request timed out.");
  } else {
    console.error(`other error: ${err}`);
  }
  process.exitCode = 1;
};

main().catch(handleError);

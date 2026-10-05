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

dotenv.config();
const MAX_STEPS = 5;
const TIME_OUT_MS = 30000;
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
  const question = process.argv.slice(2).join(" ").trim();

  if (!question) {
    throw new Error("请提供问题");
  }
  console.log(`用户的问题是: ${question}`);
  // TODO 1：连接 MCP server
  try {
    await client.connect(transport);
    // TODO 2：获取 tools
    const { tools } = await client.listTools();
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
        role: "user",
        content: question,
      },
    ];
    for (let step = 0; step < MAX_STEPS; step++) {
      console.log(`Agent step: ${step + 1}`);

      const modelStartedAt = performance.now();
      let response: OpenAI.Responses.Response;
      try {
        response = await openai.responses.create(
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
          {
            timeout: TIME_OUT_MS,
            maxRetries: 0,
          },
        );
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

      if (!functionCall) {
        console.log(`llm的结果是：${response.output_text}`);
        return;
      }

      if (!toolsName.includes(functionCall.name)) {
        throw new Error(`找不到对应的tool: ${functionCall.name}`);
      }

      console.log(`使用的 tool 名称：${functionCall.name}`);
      const toolStartedAt = performance.now();
      let toolResult: Awaited<ReturnType<Client["callTool"]>>;
      let content: Array<{ type: string; text?: string }>;
      try {
        toolResult = await client.callTool({
          name: functionCall.name,
          arguments: JSON.parse(functionCall.arguments),
        });
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
      console.log(
        `原始结果长度：${content.length}，是否报错：${toolResult.isError}`,
      );
      context.push({
        type: "function_call_output",
        call_id: functionCall.call_id,
        output: text,
      });
    }

    throw new Error(`Agent 超过最大执行步数: ${MAX_STEPS}`);
  } finally {
    // TODO 4：关闭连接
    await client.close();
  }
}
const handleError = (err: unknown) => {
  if (err instanceof APIConnectionTimeoutError) {
    console.error("Request timed out.");
  } else {
    console.error(`other error: ${err}`);
  }
  process.exitCode = 1;
};

main().catch(handleError);

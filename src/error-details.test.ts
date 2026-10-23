import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import OpenAI from "openai";

import { describeError } from "./agent-trace";
import { ModelRequestTimeoutError } from "./model-request";

// 用真实的 Hono 服务和真实的客户端中止，拿到线上实际会出现的取消原因
async function captureClientDisconnect(): Promise<{
  reason: unknown;
  signal: AbortSignal;
}> {
  let resolveCapture!: (value: { reason: unknown; signal: AbortSignal }) => void;
  const captured = new Promise<{ reason: unknown; signal: AbortSignal }>(
    (resolve) => {
      resolveCapture = resolve;
    },
  );

  const app = new Hono();
  app.post("/ask", async (c) => {
    const signal = c.req.raw.signal;
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    resolveCapture({ reason: signal.reason, signal });
    return c.json({ ok: true });
  });

  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;

  const controller = new AbortController();
  const request = fetch(`http://127.0.0.1:${port}/ask`, {
    method: "POST",
    body: "{}",
    signal: controller.signal,
  }).catch(() => undefined);
  setTimeout(() => controller.abort(), 50);

  const result = await captured;
  await request;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return result;
}

(async () => {
  // 客户端断开：原因是什么都应记为 Cancelled，而不是 UnknownError
  const disconnect = await captureClientDisconnect();
  assert.equal(disconnect.signal.aborted, true);
  assert.deepEqual(describeError(disconnect.reason, disconnect.signal), {
    errorType: "Cancelled",
    errorMessage: "Request cancelled by client",
  });

  // OpenAI SDK 的真实错误对象：保留类别、错误码、HTTP 状态和请求号
  const apiError = OpenAI.APIError.generate(
    404,
    {
      error: {
        message:
          "The model `no-such-model` does not exist or you do not have access to it.",
        type: "invalid_request_error",
        param: null,
        code: "model_not_found",
      },
    },
    undefined,
    new Headers({ "x-request-id": "req_test123" }),
  );
  assert.deepEqual(describeError(apiError), {
    errorType: "invalid_request_error",
    errorCode: "model_not_found",
    httpStatus: 404,
    requestId: "req_test123",
    errorMessage:
      "404 The model `no-such-model` does not exist or you do not have access to it.",
  });

  // 超时不是用户取消：signal 没有中止时按原错误记录
  const timeout = new ModelRequestTimeoutError(
    "Model request attempt 1 timed out after 30000ms",
  );
  assert.deepEqual(describeError(timeout, new AbortController().signal), {
    errorType: "ModelRequestTimeoutError",
    errorMessage: "Model request attempt 1 timed out after 30000ms",
  });

  // MCP 等错误的数字错误码也保留
  const mcpError = Object.assign(new Error("MCP error -32001: Request timed out"), {
    name: "McpError",
    code: -32001,
  });
  assert.deepEqual(describeError(mcpError), {
    errorType: "McpError",
    errorCode: -32001,
    errorMessage: "MCP error -32001: Request timed out",
  });

  // 非 Error 的值也要留下内容
  assert.deepEqual(describeError("socket hang up"), {
    errorType: "UnknownError",
    errorMessage: "socket hang up",
  });

  // 超长报错截断，避免把大段请求内容写进 trace
  const long = describeError(new Error("x".repeat(2_000)));
  assert.equal(long.errorMessage?.length, 201);
  assert.ok(long.errorMessage?.endsWith("…"));

  console.log("✓ error details: cancellation, OpenAI API errors, timeouts, MCP codes and truncation");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

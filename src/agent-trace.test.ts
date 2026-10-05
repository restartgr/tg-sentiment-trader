import assert from "node:assert/strict";
import { mkdtemp, readFile, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  appendToolResultTrace,
  describeToolError,
  estimateModelCostUsd,
  toolResultText,
} from "./agent-trace";

assert.equal(
  toolResultText([
    { type: "text", text: "first" },
    { type: "image" },
    { type: "text", text: "second" },
  ]),
  "first\nsecond",
);

assert.deepEqual(
  describeToolError(
    "MCP error -32602: Input validation error:\nToo small: expected number to be >=1 at batchId",
  ),
  {
    errorType: "MCPInputValidationError",
    errorCode: -32602,
    errorMessage: "Input validation error at batchId",
  },
);
assert.deepEqual(
  describeToolError("开始时间必须早于结束时间，请调整查询范围。"),
  {
    errorType: "ToolReportedError",
    errorMessage: "开始时间必须早于结束时间，请调整查询范围。",
  },
);
assert.deepEqual(describeToolError("private token=secret-value"), {
  errorType: "ToolReportedError",
  errorMessage: "Tool reported an error; details omitted from trace",
});

async function testToolErrorTrace(): Promise<void> {
  const traceDir = await mkdtemp(path.join(tmpdir(), "tg-agent-trace-"));
  const runId = "test-tool-error";
  const tracePath = path.join(traceDir, `${runId}.jsonl`);
  const rawError =
    "MCP error -32602: Input validation error:\nToo small: expected number to be >=1 at batchId";
  try {
    const output = await appendToolResultTrace(
      {
        runId,
        step: 3,
        finishedAt: "2026-10-05T00:00:00.000Z",
        latencyMs: 3,
        toolName: "explain_batch",
      },
      { isError: true, content: [{ type: "text", text: rawError }] },
      traceDir,
    );
    assert.equal(output, rawError);

    const traceText = await readFile(tracePath, "utf8");
    assert.equal(traceText.trimEnd().split("\n").length, 1);
    assert.deepEqual(JSON.parse(traceText), {
      runId,
      step: 3,
      finishedAt: "2026-10-05T00:00:00.000Z",
      latencyMs: 3,
      toolName: "explain_batch",
      eventType: "tool_call",
      status: "error",
      errorType: "MCPInputValidationError",
      errorCode: -32602,
      errorMessage: "Input validation error at batchId",
    });
    assert.equal(traceText.includes("Too small"), false);
    console.log("✓ 模拟 MCP 工具报错，trace 记录：", traceText.trim());
  } finally {
    await unlink(tracePath);
    await rmdir(traceDir);
  }
}

testToolErrorTrace().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

const shortCost = estimateModelCostUsd("gpt-5.6-sol", {
  inputTokens: 100,
  outputTokens: 50,
  cachedInputTokens: 10,
  cacheWriteInputTokens: 20,
});
assert.ok(shortCost !== undefined);
assert.ok(Math.abs(shortCost - 0.001384) < 1e-12);

const longCost = estimateModelCostUsd("gpt-5.6-sol", {
  inputTokens: 272_001,
  outputTokens: 1,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
});
assert.ok(longCost !== undefined);
assert.ok(Math.abs(longCost - 2.176038) < 1e-12);

assert.equal(
  estimateModelCostUsd("another-model", {
    inputTokens: 100,
    outputTokens: 10,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
  }),
  undefined,
);

assert.equal(
  estimateModelCostUsd("gpt-5.6-sol", {
    inputTokens: 10,
    outputTokens: 10,
    cachedInputTokens: 11,
    cacheWriteInputTokens: 0,
  }),
  undefined,
);

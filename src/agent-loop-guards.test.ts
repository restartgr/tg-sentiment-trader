import assert from "node:assert/strict";
import type OpenAI from "openai";
import {
  assertInputBudget,
  boundedToolOutput,
  MAX_INPUT_BYTES,
  MAX_TOOL_OUTPUT_BYTES,
  toolCallKey,
} from "./agent-loop-guards";

const tools: OpenAI.Responses.FunctionTool[] = [];
const source = JSON.stringify({ sourceMessageIds: [101, 102], messages: [{ id: 101, text: "涨停" }] });
assert.equal(boundedToolOutput(source), source);

const oversized = boundedToolOutput("证".repeat(MAX_TOOL_OUTPUT_BYTES));
assert.equal(JSON.parse(oversized).error, "tool_result_too_large");
assert.equal(JSON.parse(oversized).instruction.includes("No source messages"), true);
assert.equal(oversized.includes("证"), false);

assert.doesNotThrow(() => assertInputBudget([{ role: "user", content: "最近情况" }], tools));
assert.throws(() => assertInputBudget([{ role: "user", content: "证".repeat(MAX_INPUT_BYTES) }], tools), /input budget exceeded/);
assert.equal(toolCallKey("explain_batch", { batchId: 6 }), toolCallKey("explain_batch", { batchId: 6 }));
assert.equal(toolCallKey("query_batches", { limit: 5, status: "completed" }),
  toolCallKey("query_batches", { status: "completed", limit: 5 }));

console.log("✓ tool output preserves complete small evidence, rejects oversized evidence, and input budget stops before model call");

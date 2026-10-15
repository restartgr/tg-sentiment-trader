import assert from "node:assert/strict";
import { completedText, outputTokenLimit, OutputTruncatedError } from "./llm-output";

assert.equal(completedText({
  stop_reason: "end_turn",
  usage: { output_tokens: 12 },
  content: [{ type: "text", text: '{"score":0}' }],
}, 6000), '{"score":0}');

assert.throws(() => completedText({
  stop_reason: "max_tokens",
  usage: { output_tokens: 6000 },
  content: [{ type: "text", text: '{"topAssets":[' }],
}, 6000), /max_tokens\(6000\).*截断内容未用于分析/);

assert.equal(outputTokenLimit(6000), 6000);
assert.equal(outputTokenLimit(6000, new Error("connection failed")), 6000);
assert.equal(outputTokenLimit(6000, new OutputTruncatedError(6000, 6000)), 12000);

console.log("✓ truncated model JSON is rejected before parsing");

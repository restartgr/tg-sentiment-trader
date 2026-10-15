import assert from "node:assert/strict";
import { completedText, outputTokenLimit, OutputTruncatedError } from "./llm-output";
import { ModelRequestTimeoutError, runModelRequest, isTransientModelError } from "./model-request";

const policy = {
  maxAttempts: 2,
  attemptTimeoutMs: 100,
  totalTimeoutMs: 250,
  shouldRetry: isTransientModelError,
};

async function main(): Promise<void> {
  let limits: number[] = [];
  const recovered = await runModelRequest({
    ...policy,
    shouldRetry: (error) => error instanceof OutputTruncatedError || isTransientModelError(error),
  }, async ({ previousError }) => {
    const limit = outputTokenLimit(6000, previousError);
    limits.push(limit);
    return completedText({
      stop_reason: limits.length === 1 ? "max_tokens" : "end_turn",
      usage: { output_tokens: limits.length === 1 ? 6000 : 20 },
      content: [{ type: "text", text: limits.length === 1 ? "{\"score\":" : "{\"score\":0}" }],
    }, limit);
  });
  assert.equal(recovered, '{"score":0}');
  assert.deepEqual(limits, [6000, 12000]);

  limits = [];
  await assert.rejects(runModelRequest({
    ...policy,
    shouldRetry: () => true,
  }, async ({ previousError }) => {
    limits.push(outputTokenLimit(6000, previousError));
    throw Object.assign(new Error("temporary connection failure"), { name: "APIConnectionError" });
  }), /temporary connection failure/);
  assert.deepEqual(limits, [6000, 6000]);

  let invalidAttempts = 0;
  await assert.rejects(runModelRequest(policy, async () => {
    invalidAttempts++;
    throw new SyntaxError("invalid JSON");
  }), /invalid JSON/);
  assert.equal(invalidAttempts, 1);

  let timeoutAttempts = 0;
  await assert.rejects(runModelRequest({
    ...policy,
    attemptTimeoutMs: 10,
    totalTimeoutMs: 50,
  }, async ({ signal }) => {
    timeoutAttempts++;
    await new Promise<void>((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  }), ModelRequestTimeoutError);
  assert.equal(timeoutAttempts, 2);

  let lateAttempts = 0;
  await assert.rejects(runModelRequest({
    ...policy,
    maxAttempts: 1,
    attemptTimeoutMs: 10,
    totalTimeoutMs: 20,
  }, async () => {
    lateAttempts++;
    await new Promise((resolve) => setTimeout(resolve, 15));
    return "late success";
  }), ModelRequestTimeoutError);
  assert.equal(lateAttempts, 1);

  const cancelled = new AbortController();
  let cancelledAttempts = 0;
  await assert.rejects(runModelRequest({ ...policy, signal: cancelled.signal }, async ({ signal }) => {
    cancelledAttempts++;
    cancelled.abort(new Error("user cancelled"));
    await new Promise<void>((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    return "unreachable";
  }), /user cancelled/);
  assert.equal(cancelledAttempts, 1);

  const lateCancel = new AbortController();
  await assert.rejects(runModelRequest({ ...policy, signal: lateCancel.signal }, async () => {
    lateCancel.abort(new Error("cancelled before response was used"));
    return "late success";
  }), /cancelled before response was used/);

  console.log("✓ truncated output, transient errors, non-retryable errors, timeouts, and cancellation obey bounded retry policy");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

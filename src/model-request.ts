export class ModelRequestTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelRequestTimeoutError";
  }
}

export interface ModelRequestAttempt {
  attempt: number;
  previousError?: unknown;
  signal: AbortSignal;
  timeoutMs: number;
}

export interface ModelRequestPolicy {
  maxAttempts: number;
  attemptTimeoutMs: number;
  totalTimeoutMs: number;
  shouldRetry: (error: unknown) => boolean;
  onRetry?: (error: unknown, nextAttempt: number) => void | Promise<void>;
  signal?: AbortSignal;
}

export function isTransientModelError(error: unknown): boolean {
  if (error instanceof ModelRequestTimeoutError) return true;
  if (!(error instanceof Error)) return false;
  if (["APIConnectionError", "APIConnectionTimeoutError"].includes(error.name)) return true;
  const status = (error as Error & { status?: unknown }).status;
  return typeof status === "number" &&
    (status === 408 || status === 409 || status === 429 || status >= 500);
}

export async function runModelRequest<T>(
  policy: ModelRequestPolicy,
  request: (attempt: ModelRequestAttempt) => Promise<T>,
): Promise<T> {
  const { maxAttempts, attemptTimeoutMs, totalTimeoutMs } = policy;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 ||
      !Number.isSafeInteger(attemptTimeoutMs) || attemptTimeoutMs < 1 ||
      !Number.isSafeInteger(totalTimeoutMs) || totalTimeoutMs < 1) {
    throw new Error("Invalid model request policy");
  }

  const deadline = performance.now() + totalTimeoutMs;
  let previousError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (policy.signal?.aborted) throw policy.signal.reason ?? new Error("Model request cancelled");
    const remaining = Math.floor(deadline - performance.now());
    if (remaining < 1) throw new ModelRequestTimeoutError("Model request total time limit reached");
    const timeoutMs = Math.min(attemptTimeoutMs, remaining);
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort(policy.signal?.reason);
    policy.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const result = await request({ attempt, previousError, signal: controller.signal, timeoutMs });
      if (policy.signal?.aborted) throw policy.signal.reason ?? new Error("Model request cancelled");
      if (timedOut) throw new ModelRequestTimeoutError(`Model request attempt ${attempt} timed out after ${timeoutMs}ms`);
      return result;
    } catch (error) {
      if (policy.signal?.aborted) throw policy.signal.reason ?? new Error("Model request cancelled");
      const failure = timedOut
        ? new ModelRequestTimeoutError(`Model request attempt ${attempt} timed out after ${timeoutMs}ms`)
        : error;
      if (attempt === maxAttempts || performance.now() >= deadline || !policy.shouldRetry(failure)) {
        throw failure;
      }
      previousError = failure;
      await policy.onRetry?.(failure, attempt + 1);
      if (policy.signal?.aborted) throw policy.signal.reason ?? new Error("Model request cancelled");
    } finally {
      clearTimeout(timer);
      policy.signal?.removeEventListener("abort", onAbort);
    }
  }
  throw previousError ?? new Error("Model request failed");
}

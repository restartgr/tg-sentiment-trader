import type OpenAI from "openai";

// Local guardrails for this small query agent. Bytes are a conservative proxy
// for tokens, including Chinese text and serialized tool schemas.
export const MAX_INPUT_BYTES = 96_000;
export const MAX_TOOL_OUTPUT_BYTES = 24_000;

export function assertInputBudget(
  context: OpenAI.Responses.ResponseInput,
  tools: OpenAI.Responses.FunctionTool[],
): void {
  const bytes = Buffer.byteLength(JSON.stringify({ context, tools }), "utf8");
  if (bytes > MAX_INPUT_BYTES) {
    throw new Error(`Agent input budget exceeded: ${bytes} > ${MAX_INPUT_BYTES} bytes`);
  }
}

export function boundedToolOutput(text: string): string {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= MAX_TOOL_OUTPUT_BYTES) return text;
  return JSON.stringify({
    error: "tool_result_too_large",
    resultBytes: bytes,
    limitBytes: MAX_TOOL_OUTPUT_BYTES,
    instruction: "Narrow the query or lower its result limit. No source messages from this result were provided.",
  });
}

export function toolCallKey(name: string, args: Record<string, unknown>): string {
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, canonicalize(item)]),
      );
    }
    return value;
  };
  return JSON.stringify([name, canonicalize(args)]);
}

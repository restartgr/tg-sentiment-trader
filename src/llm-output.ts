interface TextResponse {
  stop_reason: string | null;
  usage: { output_tokens: number };
  content: ReadonlyArray<{ type: string; text?: string }>;
}

export class OutputTruncatedError extends Error {
  constructor(maxTokens: number, outputTokens: number) {
    super(`模型输出被 max_tokens(${maxTokens}) 截断；已输出 ${outputTokens} tokens，截断内容未用于分析`);
    this.name = "OutputTruncatedError";
  }
}

export function outputTokenLimit(baseLimit: number, previousError?: unknown): number {
  return previousError instanceof OutputTruncatedError ? baseLimit * 2 : baseLimit;
}

export function completedText(response: TextResponse, maxTokens: number): string {
  if (response.stop_reason === "max_tokens") {
    throw new OutputTruncatedError(maxTokens, response.usage.output_tokens);
  }
  if (response.stop_reason !== "end_turn") {
    throw new Error(`模型未正常完成：${response.stop_reason ?? "unknown"}`);
  }
  return response.content
    .filter((block): block is { type: "text"; text: string } =>
      block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

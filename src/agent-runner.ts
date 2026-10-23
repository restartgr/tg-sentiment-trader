import { APIConnectionTimeoutError } from "openai";
import { ModelRequestTimeoutError } from "./model-request";
import { runAgent } from "./agent-service";

async function main() {
  const question = process.argv.slice(2).join(" ").trim();
  if (!question) throw new Error("请提供问题");

  const controller = new AbortController();
  const cancel = (name: string) => controller.abort(new Error(`Agent cancelled by ${name}`));
  const onSigint = () => cancel("SIGINT");
  const onSigterm = () => cancel("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  try {
    console.log(`用户的问题是: ${question}`);
    const result = await runAgent(question, {
      signal: controller.signal,
      onProgress: (message) => console.log(message),
    });
    console.log(`llm的结果是：${result.answer}`);
    console.log(`runId: ${result.runId}; estimatedCostUsd: ${result.estimatedCostUsd ?? "unknown"}`);
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }
}

main().catch((error: unknown) => {
  if (error instanceof APIConnectionTimeoutError || error instanceof ModelRequestTimeoutError) {
    console.error("Request timed out.");
  } else {
    console.error(`other error: ${error}`);
  }
  process.exitCode = 1;
});

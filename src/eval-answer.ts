import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { isRecord, saveJsonReport } from "./rule-replay-support";

export interface CapturedToolCall {
  name: string;
  arguments: unknown;
  isError: boolean;
  resultText: string;
}

export interface CapturedAnswer {
  schemaVersion: 1;
  runId: string;
  recordedAt: string;
  question: string;
  model: string;
  toolCalls: CapturedToolCall[];
  answer: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd?: number;
}

export interface ClaimReview {
  quote: string;
  verdict: "supported" | "insufficient" | "unclear";
  reason: string;
}

export interface AnswerReview {
  schemaVersion: 1;
  caseSha256: string;
  complete: boolean;
  claims: ClaimReview[];
}

export interface AnswerEvalReport {
  schemaVersion: 1;
  evalId: string;
  generatedAt: string;
  casePath: string;
  caseSha256: string;
  reviewPath?: string;
  reviewSha256?: string;
  runId: string;
  overallStatus: "pass" | "fail" | "needs_human_review";
  sourceCheck: {
    status: "pass" | "fail";
    availableIds: number[];
    citedIds: number[];
    invalidIds: number[];
    missingCitations: boolean;
  };
  evidenceSupport: {
    status: "pass" | "fail" | "needs_human_review";
    note: string;
    complete: boolean;
    claims: ClaimReview[];
  };
  estimatedCostUsd?: number;
}

function idsFromToolResult(call: CapturedToolCall): number[] {
  if (call.isError) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(call.resultText);
  } catch {
    return [];
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.messages) || !Array.isArray(parsed.sourceMessageIds)) {
    return [];
  }
  const messageIds = parsed.messages
    .filter((item): item is { id: number } => isRecord(item) && typeof item.id === "number" && Number.isSafeInteger(item.id) && item.id > 0)
    .map((item) => item.id);
  const declaredIds = parsed.sourceMessageIds.filter((id): id is number => Number.isSafeInteger(id) && id > 0);
  // A source ID is available only when the same tool result includes its message.
  return declaredIds.filter((id) => messageIds.includes(id));
}

export function citedSourceIds(answer: string): number[] {
  const ids: number[] = [];
  const list = /sourceMessageIds[^\[]*\[([^\]]*)\]/gi;
  for (const match of answer.matchAll(list)) {
    for (const value of match[1].matchAll(/\b\d+\b/g)) ids.push(Number(value[0]));
  }
  const inline = /(?:来源消息\s*ID|来源\s*ID|消息\s*ID)\s*[:：#]?\s*(\d+)/gi;
  for (const match of answer.matchAll(inline)) ids.push(Number(match[1]));
  return [...new Set(ids.filter((id) => Number.isSafeInteger(id) && id > 0))].sort((a, b) => a - b);
}

export function evaluateCapturedAnswer(
  captured: CapturedAnswer,
  casePath: string,
  caseSha256: string,
  review?: { value: AnswerReview; path: string; sha256: string },
): AnswerEvalReport {
  const availableIds = [...new Set(captured.toolCalls.flatMap(idsFromToolResult))].sort((a, b) => a - b);
  const citedIds = citedSourceIds(captured.answer);
  const invalidIds = citedIds.filter((id) => !availableIds.includes(id));
  const missingCitations = citedIds.length === 0;
  const sourceStatus = invalidIds.length === 0 && !missingCitations ? "pass" : "fail";
  const claims = review?.value.claims ?? [];
  const evidenceStatus = claims.some((claim) => claim.verdict === "insufficient")
    ? "fail"
    : review?.value.complete && claims.every((claim) => claim.verdict === "supported")
      ? "pass"
      : "needs_human_review";
  const overallStatus = sourceStatus === "fail" || evidenceStatus === "fail"
    ? "fail"
    : evidenceStatus === "pass" ? "pass" : "needs_human_review";
  return {
    schemaVersion: 1,
    evalId: crypto.randomUUID(),
    generatedAt: new Date().toISOString(),
    casePath,
    caseSha256,
    ...(review ? { reviewPath: review.path, reviewSha256: review.sha256 } : {}),
    runId: captured.runId,
    overallStatus,
    sourceCheck: {
      status: sourceStatus,
      availableIds,
      citedIds,
      invalidIds,
      missingCitations,
    },
    evidenceSupport: {
      status: evidenceStatus,
      note: "A single insufficient claim fails the answer; unreviewed claims prevent a pass.",
      complete: review?.value.complete ?? false,
      claims,
    },
    ...(captured.estimatedCostUsd === undefined ? {} : { estimatedCostUsd: captured.estimatedCostUsd }),
  };
}

export async function saveCapturedAnswer(captured: CapturedAnswer): Promise<string> {
  const capturePath = path.join(process.cwd(), "data", "eval", "answer-cases", `${captured.runId}.json`);
  return saveJsonReport(capturePath, captured);
}

function validateCapturedAnswer(value: unknown): CapturedAnswer {
  if (!isRecord(value) || value.schemaVersion !== 1 ||
      typeof value.runId !== "string" || typeof value.question !== "string" ||
      typeof value.answer !== "string" || typeof value.model !== "string" ||
      !Array.isArray(value.toolCalls) ||
      !value.toolCalls.every((item: unknown) => isRecord(item) &&
        typeof item.name === "string" && typeof item.resultText === "string" &&
        typeof item.isError === "boolean")) {
    throw new Error("Invalid captured answer case");
  }
  return value as unknown as CapturedAnswer;
}

export function validateAnswerReview(value: unknown, captured: CapturedAnswer, caseSha256: string): AnswerReview {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.caseSha256 !== caseSha256 ||
      typeof value.complete !== "boolean" || !Array.isArray(value.claims) ||
      value.claims.length === 0 ||
      !value.claims.every((claim: unknown) => isRecord(claim) &&
        typeof claim.quote === "string" && claim.quote.length > 0 &&
        captured.answer.includes(claim.quote) &&
        ["supported", "insufficient", "unclear"].includes(claim.verdict as string) &&
        typeof claim.reason === "string" && claim.reason.trim().length > 0)) {
    throw new Error("Invalid answer review or review does not match captured case");
  }
  return value as unknown as AnswerReview;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if ((args.length !== 2 && args.length !== 4) || args[0] !== "--case" || !args[1] ||
      (args.length === 4 && (args[2] !== "--review" || !args[3]))) {
    throw new Error("Usage: pnpm eval:tg:answer --case <captured-answer.json> [--review <review.json>]");
  }
  const casePath = path.resolve(args[1]);
  const caseText = await readFile(casePath, "utf8");
  const captured = validateCapturedAnswer(JSON.parse(caseText) as unknown);
  const caseSha256 = createHash("sha256").update(caseText).digest("hex");
  let review: { value: AnswerReview; path: string; sha256: string } | undefined;
  if (args.length === 4) {
    const reviewPath = path.resolve(args[3]);
    const reviewText = await readFile(reviewPath, "utf8");
    review = {
      value: validateAnswerReview(JSON.parse(reviewText) as unknown, captured, caseSha256),
      path: reviewPath,
      sha256: createHash("sha256").update(reviewText).digest("hex"),
    };
  }
  const report = evaluateCapturedAnswer(
    captured,
    casePath,
    caseSha256,
    review,
  );
  const reportPath = path.join(process.cwd(), "data", "eval", "reports", `answer-${report.evalId}.json`);
  await saveJsonReport(reportPath, report);
  console.log(`Saved answer eval report: ${reportPath}`);
  console.log(JSON.stringify({ overallStatus: report.overallStatus, sourceCheck: report.sourceCheck, evidenceSupport: report.evidenceSupport, estimatedCostUsd: report.estimatedCostUsd }));
  if (report.overallStatus === "fail") process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Answer eval failed");
    process.exitCode = 1;
  });
}

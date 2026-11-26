// 黑话确认消息的格式与按钮回调编码（纯函数，便于测试）。
import type { MentionedAsset } from "./asset-dictionary";

export const CALLBACK_PREFIX = "alias";

export function aliasCallbackData(action: "ok" | "no", id: number): string {
  return `${CALLBACK_PREFIX}:${action}:${id}`;
}

export function parseAliasCallback(
  data: string | undefined,
): { action: "ok" | "no"; id: number } | null {
  const m = /^alias:(ok|no):(\d+)$/.exec(data ?? "");
  return m ? { action: m[1] as "ok" | "no", id: Number(m[2]) } : null;
}

export function formatAliasCandidate(
  m: Pick<MentionedAsset, "term" | "name" | "ticker" | "exchange" | "count" | "evidence">,
  yahoo: { symbol: string; name: string; price: number; currency: string },
  groupLabel: string,
): string {
  return [
    `🆕 新黑话待确认`,
    ``,
    `「${m.term}」→ ${m.name} ${m.ticker}（${m.exchange}）`,
    `📈 Yahoo：${yahoo.name} ${yahoo.symbol} 现价 ${yahoo.price} ${yahoo.currency}`,
    `💬 原话：${m.evidence || "（无）"}`,
    `📍 ${groupLabel}，本批提到 ${m.count} 次`,
  ].join("\n");
}


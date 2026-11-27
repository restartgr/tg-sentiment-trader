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
  m: Pick<MentionedAsset, "term" | "name" | "ticker" | "exchange" | "evidence"> & { count?: number },
  yahoo: { symbol: string; name: string; price?: number | null; currency?: string },
  groupLabel: string,
  options: { resend?: boolean } = {},
): string {
  return [
    options.resend ? `🔁 新黑话待确认（重发：之前的点击没收到，请重新确认）` : `🆕 新黑话待确认`,
    ``,
    `「${m.term}」→ ${m.name} ${m.ticker}（${m.exchange}）`,
    yahoo.price == null
      ? `📈 Yahoo：${yahoo.name} ${yahoo.symbol}（现价暂缺）`
      : `📈 Yahoo：${yahoo.name} ${yahoo.symbol} 现价 ${yahoo.price} ${yahoo.currency ?? ""}`.trimEnd(),
    `💬 原话：${m.evidence || "（无）"}`,
    m.count === undefined ? `📍 ${groupLabel}` : `📍 ${groupLabel}，本批提到 ${m.count} 次`,
  ].join("\n");
}


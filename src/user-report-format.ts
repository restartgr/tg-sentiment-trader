import type { UserStockReport } from "./analyzer";

// Telegram 单条消息上限 4096 字符，留余量给 emoji 等多字节符号。
export const TELEGRAM_CHUNK_LIMIT = 3800;

export interface UserMessage {
  time: string; // HH:mm JST
  text: string;
}

// 解析 "HH:MM" 为当天的分钟数；格式不对直接抛错，避免定时任务静默跑错窗口。
export function parseHHMM(value: string): number {
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) throw new Error(`时间格式应为 HH:MM，收到：${value}`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 24 || minute > 59 || (hour === 24 && minute !== 0)) {
    throw new Error(`时间超出范围：${value}`);
  }
  return hour * 60 + minute;
}

export interface ReportWindow {
  sinceMs: number;
  untilMs: number;
  sinceLabel: string;
  untilLabel: string;
}

// 以 JST 当天 00:00 为基准，计算 [since, until) 窗口；until 缺省为当前时刻。
export function computeWindow(
  dayStartMs: number,
  nowMs: number,
  since: string,
  until?: string,
): ReportWindow {
  const sinceMin = parseHHMM(since);
  const sinceMs = dayStartMs + sinceMin * 60_000;
  const untilMs = until ? dayStartMs + parseHHMM(until) * 60_000 : nowMs;
  if (untilMs <= sinceMs) {
    throw new Error(`结束时间必须晚于开始时间：${since} → ${until ?? "现在"}`);
  }
  const label = (ms: number) => {
    const min = Math.round((ms - dayStartMs) / 60_000);
    return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
  };
  return { sinceMs, untilMs, sinceLabel: label(sinceMs), untilLabel: label(untilMs) };
}

export function parseCliArgs(argv: string[]): { since: string; until?: string } {
  let since = "00:00";
  let until: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--since") since = argv[++i] ?? "";
    else if (arg === "--until") until = argv[++i];
    else throw new Error(`未知参数：${arg}（可用：--since HH:MM --until HH:MM）`);
  }
  return { since, until };
}

export function formatNoMessages(
  displayName: string,
  dateLabel: string,
  window: ReportWindow,
): string {
  return `👤 发言追踪 · ${displayName} · ${dateLabel} ${window.sinceLabel}-${window.untilLabel} JST：无发言`;
}

export function formatUserReport(
  result: UserStockReport,
  displayName: string,
  dateLabel: string,
  window: ReportWindow,
  messageCount: number,
): string {
  const lines: string[] = [
    `👤 发言追踪 · ${displayName} · ${dateLabel} ${window.sinceLabel}-${window.untilLabel} JST`,
    `发言：${messageCount} 条`,
    ``,
    `🎭 情绪：${result.mood}`,
    `📝 概要：${result.summary}`,
    ``,
  ];

  if (result.stocks.length === 0) {
    lines.push(`📌 提到的股票：无`);
  } else {
    lines.push(`📌 提到的股票`);
    result.stocks.forEach((stock, index) => {
      const code = stock.ticker && stock.ticker !== "未知" ? ` (${stock.ticker})` : "";
      lines.push(``, `${index + 1}. ${stock.name || stock.nickname}${code} · ${stock.stance}`);
      if (stock.hisView) lines.push(`观点：${stock.hisView}`);
      if (stock.quotes.length > 0) {
        lines.push(`原话：${stock.quotes.map((q) => `「${q}」`).join(" ")}`);
      }
      if (stock.analysis) lines.push(`行情分析：${stock.analysis}`);
    });
  }

  if (result.otherTopics.length > 0) {
    lines.push(``, `🗂️ 其他话题：${result.otherTopics.join("、")}`);
  }

  lines.push(``, `仅供观察，不构成投资建议。`);
  return lines.join("\n");
}

export function formatRawMessages(messages: UserMessage[]): string {
  return [
    `📜 原文（${messages.length} 条）`,
    ...messages.map((m) => `[${m.time}] ${m.text.replace(/\s*\n\s*/g, " ")}`),
  ].join("\n");
}

// 按行切分超长文本；单行本身超长时再硬切，保证每段都不超过 limit。
export function splitForTelegram(text: string, limit = TELEGRAM_CHUNK_LIMIT): string[] {
  const chunks: string[] = [];
  let current = "";
  const pushLine = (line: string) => {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= limit) {
      current = candidate;
      return;
    }
    if (current) chunks.push(current);
    current = line;
  };

  for (const line of text.split("\n")) {
    if (line.length <= limit) {
      pushLine(line);
      continue;
    }
    for (let i = 0; i < line.length; i += limit) pushLine(line.slice(i, i + limit));
  }
  if (current) chunks.push(current);
  return chunks;
}

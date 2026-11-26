// 行情交叉验证的 I/O 层：拉外部指标、拼告警附加行、提及量流水线、记录与回填事后验证。
import { TelegramClient } from "telegram";
import { config } from "./config";
import { extractMentions } from "./analyzer";
import { learnAliasesFromMentions } from "./alias-learning";
import { BotTarget, sendAlert } from "./bot-notify";
import {
  countActiveWindows,
  earliestMentionTs,
  listPendingOutcomes,
  saveAlertOutcome,
  saveMentions,
  sumMentionsBySymbol,
  updateOutcomeReturns,
} from "./db";
import { fetchYahooChart, fetchYahooQuote, MarketQuote, toYahooSymbol } from "./market-data";
import {
  computeReturns,
  detectSpikes,
  ExternalSnapshot,
  formatDivergenceLine,
  formatExternalLines,
  formatSpike,
  parseNikkeiViCsv,
} from "./market-signals";

const NKVI_CSV_URL =
  "https://indexes.nikkei.co.jp/nkave/historical/nikkei_stock_average_vi_daily_en.csv";
const NKVI_CACHE_MS = 30 * 60_000;
let nkviCache: { at: number; value: ExternalSnapshot["nikkeiVi"] } | null = null;

async function fetchNikkeiVi(): Promise<ExternalSnapshot["nikkeiVi"]> {
  if (nkviCache && Date.now() - nkviCache.at < NKVI_CACHE_MS) return nkviCache.value;
  let value: ExternalSnapshot["nikkeiVi"] = null;
  try {
    const res = await fetch(NKVI_CSV_URL, { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const parsed = parseNikkeiViCsv(await res.text());
      value = parsed ? { value: parsed.close, date: parsed.date } : null;
    }
  } catch (err) {
    console.error("日经 VI 获取失败:", err instanceof Error ? err.message : err);
  }
  nkviCache = { at: Date.now(), value };
  return value;
}

export async function fetchExternalSnapshot(): Promise<ExternalSnapshot> {
  const [vixQuote, nikkeiVi] = await Promise.all([fetchYahooQuote("^VIX"), fetchNikkeiVi()]);
  return {
    vix: vixQuote ? { value: vixQuote.price, changePercent: vixQuote.changePercent } : null,
    nikkeiVi,
  };
}

function benchmarkSymbol(): string {
  return config.report.benchmarks[0] ?? "^N225";
}

export interface MarketCheck {
  lines: string[];
  external: ExternalSnapshot;
  index: MarketQuote | null;
}

// 情绪告警附加：价格背离 + 外部指标共振。
export async function buildMarketCheck(score: number): Promise<MarketCheck> {
  const [external, index] = await Promise.all([
    fetchExternalSnapshot(),
    fetchYahooQuote(benchmarkSymbol()),
  ]);
  const indexInfo =
    index && index.changePercent !== undefined
      ? { name: index.name, changePercent: index.changePercent }
      : null;
  return {
    lines: [formatDivergenceLine(score, indexInfo), ...formatExternalLines(score, external)],
    external,
    index,
  };
}

// 情绪告警：记录指数 + 热议资产当时价格，之后回填 1/5 日涨跌。
export async function recordSentimentOutcome(params: {
  groupId: string;
  score: number;
  heat: number;
  label: string;
  check: MarketCheck;
  assets: { ticker: string; exchange: string }[];
}): Promise<void> {
  const { groupId, score, heat, label, check, assets } = params;
  const alertTs = Date.now();
  const context = { external: check.external, indexChangePercent: check.index?.changePercent ?? null };
  const quotes: MarketQuote[] = [];
  if (check.index) quotes.push(check.index);
  for (const a of assets.slice(0, 3)) {
    const symbol = toYahooSymbol(a);
    if (!symbol || quotes.some((q) => q.symbol === symbol)) continue;
    const q = await fetchYahooQuote(symbol);
    if (q) quotes.push(q);
  }
  for (const q of quotes) {
    saveAlertOutcome({
      alertTs,
      groupId,
      kind: "sentiment",
      direction: Math.sign(score),
      score,
      heat,
      label,
      symbol: q.symbol,
      basePrice: q.price,
      context,
    });
  }
}

const lastSpikeAlerts = new Map<string, { at: number; count: number }>();

// 每批一次：识别提及 → 落库 → 学黑话 → 查提及量异动。
export async function runMentionPipeline(params: {
  client: TelegramClient;
  bot: BotTarget | null;
  groupId: string;
  groupLabel: string;
  messages: { username: string; text: string; messageTs: number }[];
}): Promise<void> {
  const { client, bot, groupId, groupLabel, messages } = params;
  const mentions = await extractMentions(messages);
  const ts = Math.max(...messages.map((m) => m.messageTs));

  // 同一 symbol 的多种叫法合并计数。
  const bySymbol = new Map<string, { name: string; count: number }>();
  for (const m of mentions) {
    const symbol = toYahooSymbol(m);
    if (!symbol) continue;
    const cur = bySymbol.get(symbol);
    bySymbol.set(symbol, { name: cur?.name ?? m.name, count: (cur?.count ?? 0) + m.count });
  }
  saveMentions([...bySymbol].map(([symbol, v]) => ({ groupId, ts, symbol, name: v.name, count: v.count })));

  await learnAliasesFromMentions({ groupId, groupLabel, mentions, bot }).catch((err) =>
    console.error("黑话学习失败:", err),
  );

  await checkMentionSpikes({ client, bot, groupId, groupLabel, now: ts });
}

async function checkMentionSpikes(params: {
  client: TelegramClient;
  bot: BotTarget | null;
  groupId: string;
  groupLabel: string;
  now: number;
}): Promise<void> {
  const { client, bot, groupId, groupLabel, now } = params;
  const s = config.sentiment;
  const windowMs = s.mentionWindowMinutes * 60_000;
  const lookbackStart = now - s.mentionLookbackDays * 24 * 3600_000;
  const windowStart = now - windowMs;

  // 预热：提及记录不足 1 天时基线不可信，只记录不推送。
  const earliest = earliestMentionTs(groupId);
  if (earliest === null || now - earliest < 24 * 3600_000) return;

  const current = sumMentionsBySymbol(groupId, windowStart, now + 1);
  const history = sumMentionsBySymbol(groupId, lookbackStart, windowStart);
  const activeWindows = countActiveWindows(groupId, Math.max(lookbackStart, earliest), windowStart, windowMs);
  const spikes = detectSpikes(current, history, activeWindows, {
    minCount: s.mentionSpikeMinCount,
    ratio: s.mentionSpikeRatio,
    baselineFloor: 0.5,
  }).filter((sp) => s.mentionWatchlist.length === 0 || s.mentionWatchlist.includes(sp.symbol));

  for (const spike of spikes) {
    const key = `${groupId}:${spike.symbol}`;
    const last = lastSpikeAlerts.get(key);
    // 冷却期内只有提及数翻倍才再推。
    if (last && now - last.at < s.mentionCooldownMinutes * 60_000 && spike.count < last.count * 2) {
      continue;
    }
    lastSpikeAlerts.set(key, { at: now, count: spike.count });

    const quote = await fetchYahooQuote(spike.symbol);
    await sendAlert(client, bot, formatSpike(spike, s.mentionWindowMinutes, groupLabel, quote));
    console.log(`🗣️ 提及异动 ${spike.symbol} ${spike.count} 次（${spike.ratio.toFixed(1)} 倍）`);
    if (quote) {
      saveAlertOutcome({
        alertTs: Date.now(),
        groupId,
        kind: "mention",
        direction: 0,
        score: null,
        heat: null,
        label: `${spike.count}次/${spike.ratio.toFixed(1)}倍`,
        symbol: spike.symbol,
        basePrice: quote.price,
        context: { spike, quoteChangePercent: quote.changePercent ?? null },
      });
    }
  }
}

// 回填告警后 1/5 个交易日的涨跌。可在监听进程内定时跑，也可 `pnpm outcomes` 手动跑。
export async function evaluatePendingOutcomes(): Promise<number> {
  const now = Date.now();
  const pending = listPendingOutcomes(now - 45 * 24 * 3600_000, now - 20 * 3600_000);
  let updated = 0;
  for (const row of pending) {
    const bars = await fetchYahooChart(row.symbol, "3mo", "1d");
    if (bars.length === 0) continue;
    const { ret1d, ret5d } = computeReturns(row.basePrice, row.alertTs, bars);
    if (ret1d === null && ret5d === null) continue;
    updateOutcomeReturns(row.id, ret1d, ret5d);
    updated++;
  }
  return updated;
}

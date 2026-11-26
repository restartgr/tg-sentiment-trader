// 告警的行情交叉验证（纯函数）：外部恐慌指标、情绪与价格背离、提及量异动、事后验证。
// 所有阈值集中在这里，便于事后验证跑出数据后再调。

// ---------- 外部指标：VIX / 日经 VI / 均线乖离（市场温度） ----------

export interface ExternalSnapshot {
  vix: { value: number; changePercent?: number } | null;
  nikkeiVi: { value: number; date: string } | null;
  // 日经收盘相对 25 日均线的乖离率（%），日本散户最常用的过热/超卖指标
  n225Dev25?: number | null;
  // 标普 500 相对 125 日均线（%），即 CNN 恐惧贪婪指数的动量分项
  spxDev125?: number | null;
}

export const EXTERNAL_LEVELS = {
  vixFear: 25,
  vixCalm: 15,
  nkviFear: 30,
  nkviCalm: 20,
  n225DevHot: 5,
  n225DevCold: -5,
  spxDevHot: 8,
  spxDevCold: -2,
};

// 收盘价相对 n 日简单均线的乖离率（%）；数据不足返回 null。
export function smaDeviation(closes: number[], n: number): number | null {
  if (closes.length < n) return null;
  const window = closes.slice(-n);
  const sma = window.reduce((a, b) => a + b, 0) / n;
  return ((closes[closes.length - 1] - sma) / sma) * 100;
}

type ExternalMood = "fear" | "calm" | "neutral" | "unknown";

export function externalMood(s: ExternalSnapshot): ExternalMood {
  const vals: ExternalMood[] = [];
  if (s.vix) {
    vals.push(
      s.vix.value >= EXTERNAL_LEVELS.vixFear
        ? "fear"
        : s.vix.value <= EXTERNAL_LEVELS.vixCalm
          ? "calm"
          : "neutral",
    );
  }
  if (s.nikkeiVi) {
    vals.push(
      s.nikkeiVi.value >= EXTERNAL_LEVELS.nkviFear
        ? "fear"
        : s.nikkeiVi.value <= EXTERNAL_LEVELS.nkviCalm
          ? "calm"
          : "neutral",
    );
  }
  // 均线乖离：过热视为市场放松/贪婪（calm），超卖视为恐慌（fear）。
  const dev = (v: number | null | undefined, hot: number, cold: number) => {
    if (v === null || v === undefined) return;
    vals.push(v >= hot ? "calm" : v <= cold ? "fear" : "neutral");
  };
  dev(s.n225Dev25, EXTERNAL_LEVELS.n225DevHot, EXTERNAL_LEVELS.n225DevCold);
  dev(s.spxDev125, EXTERNAL_LEVELS.spxDevHot, EXTERNAL_LEVELS.spxDevCold);
  if (vals.length === 0) return "unknown";
  // 任一外部指标恐慌即视为外部恐慌；没有恐慌且至少一半偏放松才算放松。
  if (vals.includes("fear")) return "fear";
  if (vals.filter((v) => v === "calm").length * 2 >= vals.length) return "calm";
  return "neutral";
}

export type ExternalVerdict =
  | "double_fear" // 群内恐慌 + 外部恐慌：双重确认
  | "double_greed" // 群内亢奋 + 外部平静
  | "group_overreact_fear" // 群内恐慌但外部平静：情绪化
  | "group_early_greed" // 群内亢奋但外部紧张
  | "neutral"
  | "unknown";

export function externalVerdict(score: number, s: ExternalSnapshot): ExternalVerdict {
  const mood = externalMood(s);
  if (mood === "unknown") return "unknown";
  if (score < 0) {
    if (mood === "fear") return "double_fear";
    if (mood === "calm") return "group_overreact_fear";
  } else if (score > 0) {
    if (mood === "calm") return "double_greed";
    if (mood === "fear") return "group_early_greed";
  }
  return "neutral";
}

const VERDICT_TEXT: Record<ExternalVerdict, string> = {
  double_fear: "✅ 双重确认：群内恐慌，外部也有恐慌信号（波动率高或均线超卖）",
  double_greed: "✅ 双重确认：群内亢奋，外部也偏放松/过热",
  group_overreact_fear: "⚠️ 外部偏放松，群内恐慌偏情绪化",
  group_early_greed: "⚠️ 外部仍有恐慌信号，群内乐观可能过早",
  neutral: "外部指标中性，未形成共振",
  unknown: "外部指标获取失败",
};

export function formatExternalLines(score: number, s: ExternalSnapshot): string[] {
  const parts: string[] = [];
  if (s.vix) {
    const chg = s.vix.changePercent !== undefined ? ` (${signed(s.vix.changePercent)}%)` : "";
    parts.push(`VIX ${s.vix.value.toFixed(1)}${chg}`);
  }
  if (s.nikkeiVi) parts.push(`日经VI ${s.nikkeiVi.value.toFixed(1)}（${s.nikkeiVi.date}）`);
  const head = parts.length ? `🌡️ 波动率：${parts.join(" | ")}` : "🌡️ 波动率：无数据";
  const temp: string[] = [];
  const devText = (v: number, hot: number, cold: number) =>
    `${signed(v)}%（${v >= hot ? "过热" : v <= cold ? "超卖" : "中性"}）`;
  if (s.n225Dev25 !== null && s.n225Dev25 !== undefined) {
    temp.push(`日经 25日乖离 ${devText(s.n225Dev25, EXTERNAL_LEVELS.n225DevHot, EXTERNAL_LEVELS.n225DevCold)}`);
  }
  if (s.spxDev125 !== null && s.spxDev125 !== undefined) {
    temp.push(`标普 125日 ${devText(s.spxDev125, EXTERNAL_LEVELS.spxDevHot, EXTERNAL_LEVELS.spxDevCold)}`);
  }
  return [
    head,
    ...(temp.length ? [`📊 温度：${temp.join(" | ")}`] : []),
    `   ${VERDICT_TEXT[externalVerdict(score, s)]}`,
  ];
}

// ---------- 情绪与价格背离 ----------

export const DIVERGENCE_LEVELS = {
  minAbsScore: 0.5,
  // 恐慌时指数跌幅小于此值（%）视为"跌得不多"
  fearMaxDrop: -1,
  // 亢奋时指数涨幅小于此值（%）视为"涨不动"
  greedMinRise: 0.5,
};

export type DivergenceKind =
  | "fear_overreact"
  | "greed_exhausted"
  | "fear_aligned"
  | "greed_aligned"
  | "none";

export function classifyDivergence(score: number, indexChangePct: number | null): DivergenceKind {
  if (indexChangePct === null || Math.abs(score) < DIVERGENCE_LEVELS.minAbsScore) return "none";
  if (score < 0) {
    return indexChangePct > DIVERGENCE_LEVELS.fearMaxDrop ? "fear_overreact" : "fear_aligned";
  }
  return indexChangePct < DIVERGENCE_LEVELS.greedMinRise ? "greed_exhausted" : "greed_aligned";
}

export function formatDivergenceLine(
  score: number,
  index: { name: string; changePercent: number } | null,
): string {
  if (!index) return "📐 价格对照：指数行情获取失败";
  const chg = `${index.name} ${signed(index.changePercent)}%`;
  switch (classifyDivergence(score, index.changePercent)) {
    case "fear_overreact":
      return `📐 背离：群内恐慌，但${chg}，${index.changePercent >= 0 ? "指数并未下跌" : "跌得不多"} → 情绪可能过度反应`;
    case "greed_exhausted":
      return `📐 背离：群内亢奋，但${chg}，${index.changePercent < 0 ? "指数反而下跌" : "涨不动"} → 追高力量可能衰竭`;
    case "fear_aligned":
      return `📐 同步：群内恐慌，${chg}，情绪与下跌一致`;
    case "greed_aligned":
      return `📐 同步：群内亢奋，${chg}，情绪与上涨一致`;
    case "none":
      return `📐 价格对照：${chg}`;
  }
}

// ---------- 群内 vs 市场 汇总块 ----------

export interface GroupReading {
  label: string;
  score: number;
  heat: number;
  summary: string;
}

export function formatGroupLine(g: GroupReading): string {
  const summary = g.summary ? `｜${g.summary}` : "";
  const pctScore = Math.round(g.score * 100);
  return `🧭 群内：${g.label} ${pctScore > 0 ? "+" : ""}${pctScore}% · 烈度 ${(g.heat * 100).toFixed(0)}%${summary}`;
}

// 把背离和外部共振合成一句结论；组合不明确时返回 null（不硬凑）。
export function overallTake(div: DivergenceKind, ext: ExternalVerdict): string | null {
  if (div === "fear_overreact") {
    if (ext === "double_fear") return "外部确有压力，但指数没跟跌：群内恐慌跑在价格前面，留意情绪反转";
    if (ext === "group_overreact_fear") return "指数没跌、外部也偏放松：群内恐慌基本是情绪化，反向信号较强";
    return "指数没跟跌：群内恐慌可能过度";
  }
  if (div === "fear_aligned") {
    if (ext === "double_fear") return "群内、指数、外部三方同步恐慌：趋势中的恐慌，等情绪衰竭再看";
    return "群内恐慌与下跌同步，外部未共振";
  }
  if (div === "greed_exhausted") {
    if (ext === "double_greed") return "市场整体放松但价格涨不动：亢奋可能接近顶部";
    return "群内亢奋但价格涨不动：追高力量有衰竭迹象";
  }
  if (div === "greed_aligned") {
    if (ext === "double_greed") return "群内、指数、外部同步乐观：一致性很高，警惕过热";
    if (ext === "group_early_greed") return "跟着上涨乐观，但外部仍有恐慌信号：上涨可能不稳";
    return "群内乐观与上涨同步";
  }
  return null;
}

export function formatMarketCheckBlock(
  group: GroupReading,
  index: { name: string; changePercent: number } | null,
  external: ExternalSnapshot,
): string[] {
  const take = overallTake(
    classifyDivergence(group.score, index?.changePercent ?? null),
    externalVerdict(group.score, external),
  );
  return [
    "—— 群内 vs 市场 ——",
    formatGroupLine(group),
    formatDivergenceLine(group.score, index),
    ...formatExternalLines(group.score, external),
    ...(take ? [`💡 ${take}`] : []),
  ];
}

// ---------- 提及量异动 ----------

export interface SpikeThresholds {
  minCount: number; // 窗口内至少被提这么多次
  ratio: number; // 且至少是平时同长度窗口的这么多倍
  baselineFloor: number; // 基线下限，避免冷门股"平时 0 次"导致倍数无穷大
}

export interface MentionSpike {
  symbol: string;
  name: string;
  count: number;
  baselinePerWindow: number;
  ratio: number;
}

export function detectSpikes(
  current: Map<string, { count: number; name: string }>,
  history: Map<string, { count: number; name: string }>,
  activeWindows: number,
  t: SpikeThresholds,
): MentionSpike[] {
  const out: MentionSpike[] = [];
  for (const [symbol, cur] of current) {
    if (cur.count < t.minCount) continue;
    const hist = history.get(symbol)?.count ?? 0;
    const baselinePerWindow = activeWindows > 0 ? hist / activeWindows : 0;
    const ratio = cur.count / Math.max(baselinePerWindow, t.baselineFloor);
    if (ratio < t.ratio) continue;
    out.push({ symbol, name: cur.name, count: cur.count, baselinePerWindow, ratio });
  }
  return out.sort((a, b) => b.ratio - a.ratio);
}

export interface MentionView {
  stance: string;
  evidence: string;
}

// 群里对这只票的看法：按看多/看空/中性/分歧计数，附最多 2 条原话。
export function formatMentionViews(views: MentionView[]): string[] {
  if (views.length === 0) return [];
  const counts = new Map<string, number>();
  for (const v of views) counts.set(v.stance, (counts.get(v.stance) ?? 0) + 1);
  const tally = [...counts].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}${n > 1 ? `×${n}` : ""}`);
  const quotes = views.map((v) => v.evidence).filter(Boolean).slice(0, 2);
  return [`🧭 群内看法：${tally.join("、")}`, ...quotes.map((q) => `   💬 ${q}`)];
}

export function formatSpike(
  spike: MentionSpike,
  windowMinutes: number,
  groupLabel: string,
  quote: { price: number; currency: string; changePercent?: number } | null,
  views: MentionView[] = [],
): string {
  const price = quote
    ? `💹 ${quote.price} ${quote.currency}${quote.changePercent !== undefined ? `（${signed(quote.changePercent)}%）` : ""}`
    : "💹 行情获取失败";
  return [
    `🗣️ 提及异动：${spike.name} ${spike.symbol}`,
    ``,
    `近 ${windowMinutes} 分钟被提 ${spike.count} 次，平时约 ${spike.baselinePerWindow.toFixed(1)} 次（${spike.ratio.toFixed(1)} 倍）`,
    price,
    ...formatMentionViews(views),
    `📍 ${groupLabel}`,
  ].join("\n");
}

// ---------- 事后验证 ----------

export interface DailyBar {
  time: number; // 秒
  close: number;
}

// 告警后第 1、第 5 个交易日收盘相对告警时价格的涨跌（%）。
// 日线时间戳是当天开盘时刻：只取开盘晚于告警时刻的交易日，即"告警之后的交易日"。
export function computeReturns(
  basePrice: number,
  alertTs: number,
  bars: DailyBar[],
): { ret1d: number | null; ret5d: number | null } {
  const after = bars.filter((b) => b.time * 1000 > alertTs).sort((a, b) => a.time - b.time);
  const pct = (bar: DailyBar | undefined) =>
    bar ? ((bar.close - basePrice) / basePrice) * 100 : null;
  return { ret1d: pct(after[0]), ret5d: pct(after[4]) };
}

export interface OutcomeLike {
  kind: string;
  direction: number;
  ret1d: number | null;
  ret5d: number | null;
}

export interface OutcomeStats {
  kind: string;
  direction: number;
  alerts: number;
  evaluated: number;
  avgRet1d: number | null;
  avgRet5d: number | null;
  // 反转率：恐慌告警后 5 日上涨 / 亢奋告警后 5 日下跌 的比例
  reversalRate: number | null;
}

export function summarizeOutcomes(rows: OutcomeLike[]): OutcomeStats[] {
  const groups = new Map<string, OutcomeLike[]>();
  for (const r of rows) {
    const key = `${r.kind}:${Math.sign(r.direction)}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  return [...groups.entries()]
    .map(([key, list]) => {
      const [kind, dir] = key.split(":");
      const direction = Number(dir);
      const r1 = list.map((r) => r.ret1d).filter((x): x is number => x !== null);
      const r5 = list.map((r) => r.ret5d).filter((x): x is number => x !== null);
      const reversals = direction === 0 ? [] : r5.filter((x) => (direction < 0 ? x > 0 : x < 0));
      return {
        kind,
        direction,
        alerts: list.length,
        evaluated: r5.length,
        avgRet1d: avg(r1),
        avgRet5d: avg(r5),
        reversalRate: direction === 0 || r5.length === 0 ? null : reversals.length / r5.length,
      };
    })
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.direction - b.direction);
}

function signed(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}`;
}

// 日经 VI 官方 CSV：首行表头，末行是版权声明，取最后一条有效数据行。
export function parseNikkeiViCsv(text: string): { date: string; close: number } | null {
  const rows = text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.split(",").map((c) => c.replace(/^"|"$/g, "").trim()))
    .filter((cols) => /^\d{4}\/\d{2}\/\d{2}$/.test(cols[0] ?? "") && Number.isFinite(Number(cols[1])));
  const last = rows[rows.length - 1];
  return last ? { date: last[0], close: Number(last[1]) } : null;
}

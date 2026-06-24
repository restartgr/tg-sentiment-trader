import fs from "fs";
import path from "path";

export interface AssetConfig {
  nickname: string;
  aliases: string[];
  name: string;
  ticker: string;
  exchange: string;
}

interface MarketQuote {
  symbol: string;
  name: string;
  price: number;
  currency: string;
  changePercent?: number;
  marketTime?: string;
}

interface ChartBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface NewsItem {
  title: string;
  publisher?: string;
  publishedAt?: string;
}

interface TechnicalSnapshot {
  fib?: string;
  orb?: string;
}

const QUOTE_CACHE_MS = 60 * 1000;
const MARKET_CONTEXT_CACHE_MS = 3 * 60 * 1000;
const quoteCache = new Map<string, { expiresAt: number; value: MarketQuote | null }>();
const chartCache = new Map<string, { expiresAt: number; value: ChartBar[] }>();
const newsCache = new Map<string, { expiresAt: number; value: NewsItem[] }>();

function loadAssets(): AssetConfig[] {
  const localFile = path.join(process.cwd(), "assets.json");
  const demoFile = path.join(process.cwd(), "assets.demo.json");
  const file = fs.existsSync(localFile) ? localFile : demoFile;
  if (!fs.existsSync(file)) return [];

  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    return Array.isArray(parsed) ? parsed as AssetConfig[] : [];
  } catch (err) {
    console.error(`资产映射读取失败，已跳过：${file}`, err);
    return [];
  }
}

function toYahooSymbol(asset: Pick<AssetConfig, "ticker" | "exchange">): string | null {
  if (!asset.ticker || asset.ticker === "未知") return null;

  const ticker = asset.ticker.trim().toUpperCase();
  const exchange = asset.exchange.trim();

  if (exchange.includes("东京") || exchange.includes("TSE")) return `${ticker}.T`;
  if (exchange.includes("韩国") || exchange.includes("KRX")) return `${ticker}.KS`;
  if (exchange.includes("CME") || exchange.includes("期货")) {
    if (ticker === "NQ") return "NQ=F";
    if (ticker === "ES") return "ES=F";
  }

  return ticker;
}

function containsAsset(text: string, asset: AssetConfig): boolean {
  const terms = [asset.nickname, asset.name, asset.ticker, ...asset.aliases]
    .map((term) => term.trim())
    .filter(Boolean);

  return terms.some((term) => text.toLowerCase().includes(term.toLowerCase()));
}

function countAssetMentions(text: string, asset: AssetConfig): number {
  const terms = [asset.nickname, asset.name, asset.ticker, ...asset.aliases]
    .map((term) => term.trim())
    .filter(Boolean);
  const lowerText = text.toLowerCase();

  return terms.reduce((count, term) => {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return count + (lowerText.match(new RegExp(escaped.toLowerCase(), "g"))?.length ?? 0);
  }, 0);
}

function formatAssetContext(
  asset: AssetConfig,
  quote: MarketQuote | null,
  news: NewsItem[],
  technical: TechnicalSnapshot,
): string {
  const symbol = toYahooSymbol(asset);
  const header = `${asset.nickname}/${asset.name}(${asset.ticker}, ${asset.exchange}, Yahoo ${symbol ?? "未知"})`;
  if (!quote) {
    return [
      `${header}：行情获取失败，禁止编造当前价、支撑位、压力位`,
      formatNews(news),
      technical.fib ?? "斐波那契：K线数据不足",
      technical.orb ?? "ORB：分时数据不足",
    ].join("；");
  }

  const change =
    quote.changePercent === undefined
      ? ""
      : `，涨跌幅 ${quote.changePercent.toFixed(2)}%`;
  const time = quote.marketTime ? `，行情时间 ${quote.marketTime}` : "";
  return [
    `${header}：当前价 ${quote.price.toLocaleString("en-US")} ${quote.currency}${change}${time}`,
    formatNews(news),
    technical.fib ?? "斐波那契：K线数据不足",
    technical.orb ?? "ORB：分时数据不足",
  ].join("；");
}

function formatNews(news: NewsItem[]): string {
  if (news.length === 0) return "最近新闻：未获取到";
  return `最近新闻：${news
    .slice(0, 3)
    .map((item) => {
      const source = item.publisher ? `(${item.publisher})` : "";
      return `${item.title}${source}`;
    })
    .join(" / ")}`;
}

function formatLevel(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "未知";
}

function buildFibSnapshot(dailyBars: ChartBar[], currentPrice?: number): string | undefined {
  if (dailyBars.length < 10) return undefined;

  const recent = dailyBars.slice(-60);
  const swingHigh = Math.max(...recent.map((bar) => bar.high));
  const swingLow = Math.min(...recent.map((bar) => bar.low));
  const range = swingHigh - swingLow;
  if (!Number.isFinite(range) || range <= 0) return undefined;

  const levels: Array<[string, number]> = [
    ["23.6%", swingHigh - range * 0.236],
    ["38.2%", swingHigh - range * 0.382],
    ["50.0%", swingHigh - range * 0.5],
    ["61.8%", swingHigh - range * 0.618],
    ["78.6%", swingHigh - range * 0.786],
  ];

  const nearest =
    currentPrice === undefined
      ? ""
      : `，当前价最近 ${levels
          .slice()
          .sort((a, b) => Math.abs(a[1] - currentPrice) - Math.abs(b[1] - currentPrice))[0][0]}`;

  return `斐波那契：近60日高 ${formatLevel(swingHigh)} / 低 ${formatLevel(swingLow)}，回撤位 ${levels
    .map(([label, value]) => `${label}:${formatLevel(value)}`)
    .join("、")}${nearest}`;
}

function buildOrbSnapshot(intradayBars: ChartBar[], currentPrice?: number): string | undefined {
  if (intradayBars.length < 4) return undefined;

  const dayKey = new Date(intradayBars[intradayBars.length - 1].time * 1000)
    .toISOString()
    .slice(0, 10);
  const todayBars = intradayBars.filter((bar) =>
    new Date(bar.time * 1000).toISOString().startsWith(dayKey),
  );
  if (todayBars.length < 4) return undefined;

  const openingRange = todayBars.slice(0, Math.min(6, todayBars.length));
  const orbHigh = Math.max(...openingRange.map((bar) => bar.high));
  const orbLow = Math.min(...openingRange.map((bar) => bar.low));
  const last = currentPrice ?? todayBars[todayBars.length - 1].close;
  const status =
    last > orbHigh
      ? "向上突破开盘区间"
      : last < orbLow
        ? "跌破开盘区间"
        : "仍在开盘区间内";

  return `ORB：首30分钟区间 高 ${formatLevel(orbHigh)} / 低 ${formatLevel(orbLow)}，当前${status}`;
}

async function fetchYahooQuote(symbol: string): Promise<MarketQuote | null> {
  const cached = quoteCache.get(symbol);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1m`;
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;

    const json = await res.json() as any;
    const result = json?.chart?.result?.[0];
    const meta = result?.meta;
    if (!meta || typeof meta.regularMarketPrice !== "number") return null;

    const quote: MarketQuote = {
      symbol,
      name: meta.shortName ?? meta.longName ?? symbol,
      price: meta.regularMarketPrice,
      currency: meta.currency ?? "",
      changePercent:
        typeof meta.regularMarketChangePercent === "number"
          ? meta.regularMarketChangePercent
          : undefined,
      marketTime:
        typeof meta.regularMarketTime === "number"
          ? new Date(meta.regularMarketTime * 1000).toISOString()
          : undefined,
    };

    quoteCache.set(symbol, { expiresAt: Date.now() + QUOTE_CACHE_MS, value: quote });
    return quote;
  } catch {
    quoteCache.set(symbol, { expiresAt: Date.now() + QUOTE_CACHE_MS, value: null });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchYahooChart(
  symbol: string,
  range: string,
  interval: string,
): Promise<ChartBar[]> {
  const cacheKey = `${symbol}:${range}:${interval}`;
  const cached = chartCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return [];

    const json = await res.json() as any;
    const result = json?.chart?.result?.[0];
    const timestamps: number[] = result?.timestamp ?? [];
    const quote = result?.indicators?.quote?.[0];
    if (!quote || timestamps.length === 0) return [];

    const bars = timestamps
      .map((time, index) => ({
        time,
        open: quote.open?.[index],
        high: quote.high?.[index],
        low: quote.low?.[index],
        close: quote.close?.[index],
      }))
      .filter((bar) =>
        [bar.open, bar.high, bar.low, bar.close].every((value) => typeof value === "number"),
      ) as ChartBar[];

    chartCache.set(cacheKey, {
      expiresAt: Date.now() + MARKET_CONTEXT_CACHE_MS,
      value: bars,
    });
    return bars;
  } catch {
    chartCache.set(cacheKey, {
      expiresAt: Date.now() + MARKET_CONTEXT_CACHE_MS,
      value: [],
    });
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchYahooNews(symbol: string): Promise<NewsItem[]> {
  const cached = newsCache.get(symbol);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(symbol)}&newsCount=3&quotesCount=0`;
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return [];

    const json = await res.json() as any;
    const news = ((json?.news ?? []) as any[]).slice(0, 3).map((item) => ({
      title: item.title ?? "",
      publisher: item.publisher,
      publishedAt:
        typeof item.providerPublishTime === "number"
          ? new Date(item.providerPublishTime * 1000).toISOString()
          : undefined,
    })).filter((item) => item.title);

    newsCache.set(symbol, {
      expiresAt: Date.now() + MARKET_CONTEXT_CACHE_MS,
      value: news,
    });
    return news;
  } catch {
    newsCache.set(symbol, {
      expiresAt: Date.now() + MARKET_CONTEXT_CACHE_MS,
      value: [],
    });
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

async function buildTechnicalSnapshot(
  symbol: string,
  currentPrice?: number,
): Promise<TechnicalSnapshot> {
  const [dailyBars, intradayBars] = await Promise.all([
    fetchYahooChart(symbol, "3mo", "1d"),
    fetchYahooChart(symbol, "5d", "5m"),
  ]);

  return {
    fib: buildFibSnapshot(dailyBars, currentPrice),
    orb: buildOrbSnapshot(intradayBars, currentPrice),
  };
}

export async function buildAssetMarketContext(
  asset: Pick<AssetConfig, "nickname" | "name" | "ticker" | "exchange">,
): Promise<string> {
  const normalized: AssetConfig = {
    nickname: asset.nickname,
    aliases: [],
    name: asset.name,
    ticker: asset.ticker,
    exchange: asset.exchange,
  };
  const symbol = toYahooSymbol(normalized);
  if (!symbol) return formatAssetContext(normalized, null, [], {});

  const [quote, news] = await Promise.all([
    fetchYahooQuote(symbol),
    fetchYahooNews(symbol),
  ]);
  const technical = await buildTechnicalSnapshot(symbol, quote?.price);
  return formatAssetContext(normalized, quote, news, technical);
}

export async function buildMarketContext(
  messages: { text: string }[],
): Promise<string> {
  const text = messages.map((m) => m.text).join("\n");
  const assets = loadAssets()
    .filter((asset) => containsAsset(text, asset))
    .sort((a, b) => countAssetMentions(text, b) - countAssetMentions(text, a))
    .slice(0, 5);

  if (assets.length === 0) {
    return "未从本地资产表命中资产；禁止编造当前价、支撑位、压力位。";
  }

  const lines = await Promise.all(
    assets.map(async (asset) => {
      return buildAssetMarketContext(asset);
    }),
  );

  return lines.join("\n");
}

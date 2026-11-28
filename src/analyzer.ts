import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config";
import { MentionedAsset, MentionKind, MentionStance } from "./asset-dictionary";
import { buildAssetMarketContext, buildMarketContext } from "./market-data";
import { derivePanicMetrics } from "./panic-metrics";
import {
  coerceHeatDriver,
  HeatDriver,
  HEAT_DRIVERS,
  scoreLabel,
  SentimentLabel,
  SignalStance,
} from "./routing";
import { completedText, outputTokenLimit, OutputTruncatedError } from "./llm-output";
import { isTransientModelError, runModelRequest } from "./model-request";
import {
  assetHints,
  HEAT_DRIVER_RULES,
  HEAT_RUBRIC,
  LONG_SHORT_LENS,
  NO_FABRICATION,
  NO_JUDGMENT,
  SCORE_RUBRIC,
  selfMockeryRule,
  twoAxesRule,
} from "./prompts";

// apiKey 在 config 层已用 requireEnv 强制必填，这里可无条件构造。
const anthropicClient = new Anthropic({ apiKey: config.llm.apiKey });

// light：每批都跑的轻量评分/提及识别。deep：日报、鬼叫、发言追踪等定时分析。
// alert：实时告警的深度分析与单票分析——次数少、最需要判断力，用最强的模型。
type ModelTier = "light" | "deep" | "alert";

function pickModel(tier: ModelTier): string {
  if (tier === "light") return config.llm.modelLight;
  if (tier === "alert") return config.llm.modelAlert;
  return config.llm.modelDeep;
}

// 这些模型可能以 stop_reason=refusal 拒答；开启服务端 fallback，拒答时由 API 自动换模型重跑。
const SERVER_FALLBACK_MODELS = new Set([
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-sonnet-5-5",
  "claude-fable-5-1",
  "claude-fable-5-2",
]);

console.log(
  `🤖 使用模型：light=${config.llm.modelLight} / deep=${config.llm.modelDeep} / alert=${config.llm.modelAlert}`,
);

interface ChatOptions {
  // 机械性的抽取任务不需要思考：思考 token 按输出价计费，关掉能省大半成本。
  noThinking?: boolean;
  // JSON schema：经 output_config.format 做约束解码，模型输出保证合法 JSON 且符合 schema。
  schema?: Record<string, unknown>;
  // system 跨调用字节级稳定时开启 prompt caching：命中后这部分输入按约 0.1 倍价计费。
  // 1h TTL：写入价 2 倍，但群消息节奏稀疏时 5 分钟窗口几乎回回落空。
  // 只给高频调用开；每批都变的内容（候选资产、操作框架等）必须放 user 消息，别放 system。
  cacheSystem?: boolean;
}

async function chat(
  system: string,
  user: string,
  maxTokens: number,
  tier: ModelTier = "deep",
  options: ChatOptions = {},
): Promise<string> {
  const model = pickModel(tier);
  const attemptTimeoutMs = tier === "light" ? 60_000 : 180_000;
  return runModelRequest({
    maxAttempts: 2,
    attemptTimeoutMs,
    totalTimeoutMs: attemptTimeoutMs * 2 + 5_000,
    shouldRetry: (error) => error instanceof OutputTruncatedError || isTransientModelError(error),
    onRetry: (error, nextAttempt) => {
      console.warn(`模型请求准备第 ${nextAttempt} 次尝试：${error instanceof Error ? error.name : "UnknownError"}`);
    },
  }, async ({ previousError, signal, timeoutMs }) => {
    const outputLimit = outputTokenLimit(maxTokens, previousError);
    const params = {
      model,
      max_tokens: outputLimit,
      ...(options.noThinking ? { thinking: { type: "disabled" as const } } : {}),
      ...(options.schema
        ? { output_config: { format: { type: "json_schema" as const, schema: options.schema } } }
        : {}),
      system: options.cacheSystem
        ? [{
            type: "text" as const,
            text: system,
            cache_control: { type: "ephemeral" as const, ttl: "1h" as const },
          }]
        : system,
      messages: [{ role: "user" as const, content: user }],
    };
    const requestOptions = { signal, timeout: timeoutMs, maxRetries: 0 };
    const logCache = (usage: {
      cache_creation_input_tokens?: number | null;
      cache_read_input_tokens?: number | null;
    }) => {
      if (!options.cacheSystem) return;
      const written = usage.cache_creation_input_tokens ?? 0;
      const read = usage.cache_read_input_tokens ?? 0;
      // read 一直为 0 说明前缀没稳定住（或短于该模型的最小可缓存长度），需要排查。
      if (written > 0 || read > 0) console.log(`🧠 prompt cache：写入 ${written} / 命中 ${read} tokens`);
    };
    if (SERVER_FALLBACK_MODELS.has(model)) {
      const res = await anthropicClient.beta.messages.create(
        { ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" },
        requestOptions,
      );
      logCache(res.usage);
      return completedText(res, outputLimit);
    }
    const res = await anthropicClient.messages.create(params, requestOptions);
    logCache(res.usage);
    return completedText(res, outputLimit);
  });
}

// 结构化输出：schema 由 API 约束解码保证，JSON.parse 不会失败；
// 字段语义（范围、枚举兜底）仍由各调用方的 coerce/clamp 把守。
async function chatJSON<T>(
  system: string,
  user: string,
  maxTokens: number,
  schema: Record<string, unknown>,
  tier: ModelTier = "deep",
  options: Omit<ChatOptions, "schema"> = {},
): Promise<T> {
  const raw = await chat(system, user, maxTokens, tier, { ...options, schema });
  return JSON.parse(raw) as T;
}

function clampNumber(value: unknown, min: number, max: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(min, Math.min(max, numeric));
}

const HEAT_DRIVER_SCHEMA = { type: "string", enum: HEAT_DRIVERS } as const;

export interface AssetInfo {
  nickname: string; // 群里的叫法，如"苹果"、"特斯拉"
  name: string; // 正式名称，如"Apple"、"Tesla"
  ticker: string; // 代码，如"AAPL"、"TSLA"、"7203"
  exchange: string; // 交易所，如"NYSE"、"NASDAQ"、"上交所"、"期货"
}

export interface BatchAnalysisResult {
  score: number; // 方向轴：看涨(+) / 看跌(-)
  heat: number; // 烈度轴：0~1，群体情绪激烈程度，与方向无关
  heatDriver: HeatDriver; // 烈度来源，凭消息证据判断，只解释来源不替代 score 定方向
  label: SentimentLabel; // 由 score 推导，不再让模型输出
  topAssets: AssetInfo[]; // 最多 3 个最热资产
  dominantEmotion: string; // 主导情绪（恐慌/亢奋/迷茫/分歧/麻木/嘲讽 等）
  emotionDetail: string; // 情绪细节描述 (2-3 句)
  divergence: string; // 多空分歧 / 一致性描述
  crowdBehavior: string; // 典型群体行为模式
  hotTopics: string[]; // 讨论焦点（最多 5 个）
  riskWarning: string; // 风险提示
  marketInsight: string; // 基于行情、新闻、斐波那契、ORB 的补充分析
  summary: string;
  signal: string; // 由程序定框架（跟随/反向/观望）+ 模型填理由与条件，组装成文本
}

// 初筛轮只做最轻量的情绪打分：分数 + 主导情绪 + 一句点评。
// 资产识别/行情/点位等重活留给达标后的深度轮 analyzeBatch，避免每个 batch 都白跑。
export interface BatchScoreResult {
  score: number; // 方向轴：看涨(+) / 看跌(-)，只看与股票/持仓/行情有关的有效发言
  heat: number; // 烈度轴：0~1，群体情绪激烈程度，看全部消息（含与股票无关的争吵）
  heatDriver: HeatDriver; // 烈度来源，凭消息证据判断，只解释来源不替代 score 定方向
  label: SentimentLabel; // 由 score 推导
  dominantEmotion: string;
  comment: string;
}

export interface AssetDetailAnalysis {
  title: string;
  mood: string;
  news: string;
  technical: string;
  emotionSignal: string;
  tradeView: string;
  levels: string;
  risk: string;
}

const BATCH_SCORE_SCHEMA = {
  type: "object",
  properties: {
    score: { type: "number", description: "方向轴，-1~+1" },
    heat: { type: "number", description: "烈度轴，0~1" },
    heatDriver: HEAT_DRIVER_SCHEMA,
    dominantEmotion: { type: "string", description: "一个词概括主导情绪" },
    comment: { type: "string", description: "低于 30 字的中文点评" },
  },
  required: ["score", "heat", "heatDriver", "dominantEmotion", "comment"],
  additionalProperties: false,
} as const;

interface RawBatchScore {
  score: number;
  heat: number;
  heatDriver: string;
  dominantEmotion: string;
  comment: string;
}

export async function analyzeBatchScore(
  messages: { username: string; text: string }[],
  paceNote = "",
): Promise<BatchScoreResult> {
  const formatted = messages.map((m) => `@${m.username}: ${m.text}`).join("\n");
  const heatHigh = config.sentiment.heatDeepThreshold;
  const system = `你是散户投机群的轻量情绪评分器。判断这批消息的群体情绪，输出两根相互独立的轴：方向(score) 和 烈度(heat)。不识别资产、不做行情/新闻/技术分析、不编造任何价位。输出务必极简。

${twoAxesRule()}

${HEAT_DRIVER_RULES}

${LONG_SHORT_LENS}

${selfMockeryRule(`heat 应 ≥${heatHigh}`)}

${SCORE_RUBRIC}

${HEAT_RUBRIC}

dominantEmotion 用一个词概括主导情绪（如恐慌/亢奋/迷茫/分歧/争吵/麻木/嘲讽 等）。
comment 写一句很短的中文点评，低于 30 字，说明方向与烈度（哪一边情绪更强、是否在吵），不要给交易建议。`;

  try {
    const json = await chatJSON<RawBatchScore>(
      system,
      `${paceNote ? `${paceNote}\n\n` : ""}以下是最近 ${messages.length} 条群消息：\n\n${formatted}`,
      1000,
      BATCH_SCORE_SCHEMA as unknown as Record<string, unknown>,
      "light",
      // 初筛只做粗判断：要不要进深度轮由阈值决定，细致判断留给 alert 模型。
      { noThinking: true, cacheSystem: true },
    );
    const score = clampNumber(json.score, -1, 1);
    return {
      score,
      heat: clampNumber(json.heat, 0, 1),
      heatDriver: coerceHeatDriver(json.heatDriver),
      label: scoreLabel(score),
      dominantEmotion: json.dominantEmotion ?? "",
      comment: json.comment || "情绪暂无明显极端变化。",
    };
  } catch (e) {
    // 不兜底成中性：解析失败会伪装成一次真实的「中性」读数，混进档位判断。
    // 直接抛出，由调用方明确报「解析失败」。
    console.error("轻量情绪评分失败:", e);
    throw e;
  }
}

function coerceStance(stance: unknown): MentionStance {
  return stance === "看多" || stance === "看空" || stance === "分歧" ? stance : "中性";
}

function coerceMentionKind(kind: unknown): MentionKind {
  return kind === "代码" || kind === "俗称" ? kind : "正式名";
}

const MENTIONS_SCHEMA = {
  type: "object",
  properties: {
    mentions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          term: { type: "string", description: "群里原样出现的叫法" },
          kind: { type: "string", enum: ["代码", "正式名", "俗称"] },
          name: { type: "string" },
          ticker: { type: "string" },
          exchange: { type: "string" },
          stance: { type: "string", enum: ["看多", "看空", "中性", "分歧"] },
          evidence: { type: "string", description: "最能说明指代的原话片段，≤40 字" },
        },
        required: ["term", "kind", "name", "ticker", "exchange", "stance", "evidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["mentions"],
  additionalProperties: false,
} as const;

interface RawMention {
  term: string;
  kind: string;
  name: string;
  ticker: string;
  exchange: string;
  stance: string;
  evidence: string;
}

// 提及次数由程序统计：模型数数不可靠，而提及量异动检测直接依赖这个数字。
function countTermMessages(messages: { text: string }[], term: string): number {
  const lowered = term.toLowerCase();
  const hits = messages.filter((m) => m.text.toLowerCase().includes(lowered)).length;
  return Math.max(1, hits);
}

// 资产提及识别（light）：每批独立跑，不影响情绪评分 prompt。
// 词典里的叫法按词典映射；词典没有的新叫法由模型凭上下文推断，交给调用方去确认。
export async function extractMentions(
  messages: { username: string; text: string }[],
): Promise<MentionedAsset[]> {
  const formatted = messages.map((m) => `@${m.username}: ${m.text}`).join("\n");
  const system = `你是散户股票群的资产识别器。找出这批消息里提到的每个股票/指数/期货。

已知俗称词典（叫法=正式名称/代码/交易所）：${assetHints()}

规则：
- term 必须是群里原样出现的叫法（原文里的字，不要改写成正式名）。同一资产用了不同叫法时分开列。
- 词典里有的叫法，按词典给 name/ticker/exchange。
- 词典里没有的叫法：只有上下文足够明确（同时提到公司名、代码、所属行业、价格或明显指代）才推断；不确定 ticker 填"未知"。
- 日股 ticker 写 4 位代码（如 8035、285A），exchange 写"东京证券交易所"；美股写代码，exchange 写 NASDAQ 或 NYSE；指数写 Yahoo 代码如 ^N225。
- "那个票""它""这个"等代词不算，不要猜。
- evidence = 一条最能说明该叫法指代谁的原话，截短到 40 字以内。
- stance = 群里对该资产的整体看法：看多 / 看空 / 中性 / 分歧（多空都有）。只凭原话判断，拿不准填中性。
- kind 标注叫法类型：
  - "代码"：叫法就是代码或带代码（如 8035、NVDA、レーザーテック<6920>）。
  - "正式名"：公司/指数的正式名称、常用简称或官方英文/日文/中文名（如 三菱UFJ、AEON、mizuho、日经、TOPIX、东京电子、Tokyo Electron）。
  - "俗称"：群里特有的外号、谐音、昵称、错别字变体（如 父皇、塞子、电王、镭射、乌冬）。拿不准就标"正式名"。
- 最多列 10 个，按讨论热度从高到低。没有提到任何资产就返回空数组。`;

  const json = await chatJSON<{ mentions: RawMention[] }>(
    system,
    `以下是 ${messages.length} 条群消息：\n\n${formatted}`,
    2000,
    MENTIONS_SCHEMA as unknown as Record<string, unknown>,
    "light",
    // system 含词典提示：词典更新时前缀变化、缓存自然重建，属预期失效。
    { noThinking: true, cacheSystem: true },
  );
  const list = Array.isArray(json.mentions) ? json.mentions : [];
  return list
    .map((m) => ({
      term: String(m.term ?? "").trim(),
      kind: coerceMentionKind(m.kind),
      name: String(m.name ?? "").trim(),
      ticker: String(m.ticker ?? "未知").trim() || "未知",
      exchange: String(m.exchange ?? "").trim(),
      count: countTermMessages(messages, String(m.term ?? "").trim()),
      evidence: String(m.evidence ?? "").trim().slice(0, 80),
      stance: coerceStance(m.stance),
    }))
    .filter((m: MentionedAsset) => m.term.length > 0);
}

// 简单分析档使用：不调行情时注入此上下文，约束模型不要编造任何价位。
export const NO_MARKET_CONTEXT =
  "本档为简单分析，未调取实时行情。禁止输出任何当前价、支撑位、压力位、目标价、新闻或具体价位区间；marketInsight 请固定返回'本档未调取行情，仅基于群聊情绪'。";

// 行情上下文抽成独立方法，由调用方决定是否拉取、再注入 analyzeBatch。
export async function buildBatchMarketContext(
  messages: { text: string }[],
): Promise<string> {
  return safeBuildMarketContext(messages);
}

const ASSET_INFO_SCHEMA = {
  type: "object",
  properties: {
    nickname: { type: "string" },
    name: { type: "string" },
    ticker: { type: "string" },
    exchange: { type: "string" },
  },
  required: ["nickname", "name", "ticker", "exchange"],
  additionalProperties: false,
} as const;

const BATCH_ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    score: { type: "number", description: "方向轴，-1~+1" },
    heat: { type: "number", description: "烈度轴，0~1" },
    heatDriver: HEAT_DRIVER_SCHEMA,
    dominantEmotion: { type: "string" },
    emotionDetail: { type: "string" },
    divergence: { type: "string" },
    crowdBehavior: { type: "string" },
    hotTopics: { type: "array", items: { type: "string" } },
    riskWarning: { type: "string" },
    marketInsight: { type: "string" },
    summary: { type: "string" },
    topAssets: { type: "array", items: ASSET_INFO_SCHEMA },
    signal: {
      type: "object",
      properties: {
        summary: { type: "string", description: "围绕给定操作框架的一句总判断" },
        reason: { type: "string", description: "一句说明群体情绪质量，点明烈度与发言节奏" },
        assets: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "与 topAssets 对应的资产名" },
              holder: { type: "string", description: "已持仓者的处理条件" },
              nonHolder: { type: "string", description: "未持仓者的处理条件" },
            },
            required: ["name", "holder", "nonHolder"],
            additionalProperties: false,
          },
        },
      },
      required: ["summary", "reason", "assets"],
      additionalProperties: false,
    },
  },
  required: [
    "score", "heat", "heatDriver", "dominantEmotion", "emotionDetail", "divergence",
    "crowdBehavior", "hotTopics", "riskWarning", "marketInsight", "summary", "topAssets", "signal",
  ],
  additionalProperties: false,
} as const;

interface RawBatchAnalysis {
  score: number;
  heat: number;
  heatDriver: string;
  dominantEmotion: string;
  emotionDetail: string;
  divergence: string;
  crowdBehavior: string;
  hotTopics: string[];
  riskWarning: string;
  marketInsight: string;
  summary: string;
  topAssets: AssetInfo[];
  signal: {
    summary: string;
    reason: string;
    assets: { name: string; holder: string; nonHolder: string }[];
  };
}

function formatSignalText(
  stance: SignalStance,
  signal: RawBatchAnalysis["signal"],
): string {
  const lines = [`【${stance}】${signal.summary}`, `理由：${signal.reason}`];
  if (signal.assets.length > 0) {
    lines.push("已持仓者：", ...signal.assets.map((a) => `- ${a.name}：${a.holder}`));
    lines.push("未持仓者：", ...signal.assets.map((a) => `- ${a.name}：${a.nonHolder}`));
  }
  return lines.join("\n");
}

function formatMentionCandidates(mentions: MentionedAsset[]): string {
  if (mentions.length === 0) return "（本批未识别到资产）";
  return mentions
    .slice(0, 8)
    .map((m) => `- ${m.term} → ${m.name}/${m.ticker}/${m.exchange}（${m.count} 条消息提及，群内${m.stance}）`)
    .join("\n");
}

export async function analyzeBatch(
  messages: { username: string; text: string }[],
  marketContext: string,
  paceNote = "",
  context: { mentions?: MentionedAsset[]; stance?: SignalStance } = {},
): Promise<BatchAnalysisResult> {
  const formatted = messages.map((m) => `@${m.username}: ${m.text}`).join("\n");
  const heatHigh = config.sentiment.heatDeepThreshold;
  const stance: SignalStance = context.stance ?? "观望";
  const system = `你是散户投机群的情绪分析器。深度分析一批群消息的群体情绪，重点是情绪本身，资产只作为辅助。

${NO_JUDGMENT}

${LONG_SHORT_LENS}

${twoAxesRule()}

${SCORE_RUBRIC}

${HEAT_RUBRIC}

${selfMockeryRule(`heat 应 ≥${heatHigh}`)}
- emotionDetail 可点明'以自嘲方式表达的焦虑/无力'。

${HEAT_DRIVER_RULES}

【重点 - 情绪分析】
dominantEmotion: 一个词概括主导情绪（如恐慌/亢奋/迷茫/分歧/麻木/FOMO/绝望/侥幸/狂热/犹豫 等）
emotionDetail: 2-3 句话客观描述情绪状态本身，只观察情绪倾向和强度变化。例：'多数人对反弹持怀疑，担忧二次探底；少部分人情绪转向乐观但带犹豫'。
divergence: 描述多空分歧或共识程度（如"高度一致看空"/"多空分歧明显"/"情绪由空转多"），只说情绪状态。
crowdBehavior: 描述群体的情绪反应模式，只说情绪行为（如"追涨情绪上升"/"恐慌情绪蔓延"/"观望情绪占主导"/"FOMO情绪抬头"）。
hotTopics: 讨论焦点关键词，最多 5 个（如["美联储","英伟达财报","抄底","止损"]）
riskWarning: 仅从情绪角度提示风险（如"情绪过于一致，反转概率升高"/"发言密集情绪过热，警惕反向"）。

【辅助 - 资产确认】
用户消息的【候选资产】段列出了程序已从本批消息识别出的候选。
topAssets：从候选中挑出讨论最热的最多 3 个；候选识别明显有误时可按消息内容修正 name/ticker/exchange；不确定代码 ticker 填"未知"；没有合适的就返回空数组。

【signal - 操作框架由程序判定】
用户消息的【操作框架】段给出本轮框架（跟随/反向/观望），不要更改它。
signal.summary 写围绕该框架的一句总判断；signal.reason 一句说明群体情绪质量，须点明当前烈度与发言节奏。
signal.assets 逐个覆盖 topAssets 中的每个资产（name 与 topAssets 对应），不要只写最热门的一个：
- holder：已持仓者继续持有/减仓/止损/观望的条件，必须结合情绪与行情上下文；没有可靠行情就写等待确认，不编造点位。
- nonHolder：未持仓者是否追入/等待/避开的条件。
某资产行情数据不足时也必须列出，并明确写'行情数据不足，暂不做点位判断'。
若框架为观望，summary 和各资产条件都围绕观望/等待触发写，不给买卖方向。

${NO_FABRICATION}
marketInsight: 针对 topAssets 里的重要资产，用 2-4 句话概括最近新闻、斐波那契回撤位置、ORB 开盘区间状态。只引用行情上下文提供的数据。`;

  try {
    const json = await chatJSON<RawBatchAnalysis>(
      system,
      [
        `【操作框架】${stance}`,
        ``,
        `【候选资产】`,
        formatMentionCandidates(context.mentions ?? []),
        ``,
        `以下是实时/近实时行情上下文，只能作为事实参考：`,
        marketContext,
        ``,
        paceNote ? `${paceNote}\n` : "",
        `以下是最近 ${messages.length} 条群消息：`,
        ``,
        formatted,
      ].join("\n"),
      // Opus 会先思考再输出，思考也占 max_tokens，给足空间避免截断重试。
      12000,
      BATCH_ANALYSIS_SCHEMA as unknown as Record<string, unknown>,
      "alert",
      { cacheSystem: true },
    );
    const score = clampNumber(json.score, -1, 1);
    const topAssets = Array.isArray(json.topAssets) ? json.topAssets.slice(0, 3) : [];
    return {
      score,
      heat: clampNumber(json.heat, 0, 1),
      heatDriver: coerceHeatDriver(json.heatDriver),
      label: scoreLabel(score),
      topAssets,
      dominantEmotion: json.dominantEmotion ?? "",
      emotionDetail: json.emotionDetail ?? "",
      divergence: json.divergence ?? "",
      crowdBehavior: json.crowdBehavior ?? "",
      hotTopics: Array.isArray(json.hotTopics) ? json.hotTopics.slice(0, 5) : [],
      riskWarning: json.riskWarning ?? "",
      marketInsight: json.marketInsight ?? "",
      summary: json.summary ?? "",
      signal: formatSignalText(stance, json.signal ?? { summary: "", reason: "", assets: [] }),
    };
  } catch (e) {
    // 不兜底成中性：失败若返回 score:0 会被当成一次真实的中性读数。
    // 直接抛出，由调用方明确报「分析失败」。
    console.error("批量分析失败:", e);
    throw e;
  }
}

const ASSET_DETAIL_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    mood: { type: "string" },
    news: { type: "string" },
    technical: { type: "string" },
    emotionSignal: { type: "string" },
    tradeView: { type: "string" },
    levels: { type: "string" },
    risk: { type: "string" },
  },
  required: ["title", "mood", "news", "technical", "emotionSignal", "tradeView", "levels", "risk"],
  additionalProperties: false,
} as const;

export async function analyzeAssetDetail(
  asset: AssetInfo,
  batch: BatchAnalysisResult,
  messages: { username: string; text: string }[],
): Promise<AssetDetailAnalysis> {
  const formatted = messages.map((m) => `@${m.username}: ${m.text}`).join("\n");
  const detailMin = config.sentiment.assetDetailMinAbsScore;
  const system = `你是交易辅助分析器。针对单个热门资产，结合群聊情绪、最近新闻、斐波那契回撤和 ORB 开盘区间，输出一条独立分析。

【核心要求】
- 只分析资产和市场，不评价群成员人格或能力。
- 可以使用"散户情绪浓厚""追涨情绪浓厚""悲观情绪浓厚"等客观表述。
- 如果散户情绪浓厚、追涨情绪极端或悲观情绪浓厚，需要给出买入/卖出/观望评价。
- 当本批群体情绪绝对值达到 ${detailMin} 以上，且方向较一致、散户情绪浓厚时，允许给【买入】或【卖出】候选，但必须写清触发点位和仓位克制。
- 当本批群体情绪绝对值达到 ${detailMin} 以上，且出现疯狂追涨、无脑看多、恐慌割肉、绝望看空等情绪时，可以更明确地标注为强反向信号。
- 如果只是普通乐观/普通悲观/分歧明显，即使有技术点位，也必须给【观望】，写等待情绪升温或关键位确认。
- 点位必须来自行情上下文里的当前价、斐波那契位、ORB 高低点。
- 如果行情上下文显示行情获取失败或技术数据不足，tradeView 和 levels 必须降级为观望/等待数据，不得给具体点位。
- 这不是投资建议，要强调仓位和止损风险。

${NO_FABRICATION}

【字段要求】
title: 资产名 + ticker。
mood: 该资产在群里的情绪状态，1句。
news: 最近新闻摘要；没取到新闻就说新闻缺失。
technical: 斐波那契和 ORB 状态，引用具体点位。
emotionSignal: 情绪是否过热/过悲观，以及反向意义。
tradeView: 【买入/卖出/观望】+ 触发条件，必须分别说明已持仓者和未持仓者怎么处理，两个视角都要提一嘴。${detailMin} 以上可给买卖候选；否则观望。
levels: 关键点位，必须来自行情上下文；可写'ORB高/低、Fib xx%、当前价附近'。
risk: 1句风险提示。`;

  try {
    const marketContext = await safeBuildAssetMarketContext(asset);
    const json = await chatJSON<AssetDetailAnalysis>(
      system,
      [
        `目标资产：${asset.nickname}/${asset.name}/${asset.ticker}/${asset.exchange}`,
        ``,
        `行情/新闻/技术上下文：`,
        marketContext,
        ``,
        `本批群体情绪：${batch.label}，得分 ${batch.score.toFixed(2)}，主导情绪 ${batch.dominantEmotion}`,
        `情绪细节：${batch.emotionDetail}`,
        `分歧状态：${batch.divergence}`,
        ``,
        `最近群消息：`,
        formatted,
      ].join("\n"),
      // 单票分析跟随告警档，同样用 alert 模型；给思考留出空间。
      4000,
      ASSET_DETAIL_SCHEMA as unknown as Record<string, unknown>,
      "alert",
      { cacheSystem: true },
    );
    return {
      title: json.title || `${asset.name} ${asset.ticker}`,
      mood: json.mood ?? "",
      news: json.news ?? "",
      technical: json.technical ?? "",
      emotionSignal: json.emotionSignal ?? "",
      tradeView: json.tradeView || "【观望】数据不足或情绪不极端",
      levels: json.levels ?? "",
      risk: json.risk ?? "",
    };
  } catch (e) {
    console.error(`单票分析失败 ${asset.nickname}(${asset.ticker}):`, e);
    return {
      title: `${asset.name} ${asset.ticker}`,
      mood: "分析失败",
      news: "分析失败",
      technical: "分析失败",
      emotionSignal: "分析失败",
      tradeView: "【观望】分析失败",
      levels: "",
      risk: "数据异常，先不做交易判断。",
    };
  }
}

export interface DailySummaryResult {
  score: number;
  heat: number;
  heatDriver: HeatDriver;
  label: SentimentLabel;
  dominantEmotion: string;
  discussionSummary: string;
  marketAnalysis: string;
  sentimentVsMarket: string;
  marketOutlook: string;
  hotTopics: string[];
  riskWarning: string;
  summary: string;
}

const DAILY_SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    score: { type: "number", description: "方向轴，-1~+1" },
    heat: { type: "number", description: "烈度轴，0~1" },
    heatDriver: HEAT_DRIVER_SCHEMA,
    dominantEmotion: { type: "string" },
    discussionSummary: { type: "string" },
    marketAnalysis: { type: "string" },
    sentimentVsMarket: { type: "string" },
    marketOutlook: { type: "string" },
    hotTopics: { type: "array", items: { type: "string" } },
    riskWarning: { type: "string" },
    summary: { type: "string" },
  },
  required: [
    "score", "heat", "heatDriver", "dominantEmotion", "discussionSummary", "marketAnalysis",
    "sentimentVsMarket", "marketOutlook", "hotTopics", "riskWarning", "summary",
  ],
  additionalProperties: false,
} as const;

export async function analyzeDailySummary(
  messages: { username: string; text: string }[],
  marketContext: string,
  statsContext: string,
): Promise<DailySummaryResult> {
  const formatted = messages
    .map((message) => `@${message.username}: ${message.text}`)
    .join("\n");
  const heatHigh = config.sentiment.heatDeepThreshold;
  const system = `你是市场群聊与大盘分析师。请基于今天 JST 09:00 截至当前的完整群聊和给定的大盘行情，生成一份今日综合总结。

这不是鬼叫指数报告：不要统计鬼叫、炫耀或排行榜。暂不做个股详情、逐只个股技术分析或个股买卖建议。

${NO_JUDGMENT}

【普通讨论总结】
- discussionSummary：概括今天大家主要讨论了什么，包括观点、信息、疑问和分歧，不要只挑极端情绪。
- hotTopics：最多 5 个讨论主题，可以包含资产名称，但只列主题，不展开逐只个股分析。

${twoAxesRule()}

${SCORE_RUBRIC}

${HEAT_RUBRIC}

${HEAT_DRIVER_RULES}

${LONG_SHORT_LENS}

${selfMockeryRule(`heat 应 ≥${heatHigh}`)}

【大盘详细分析】
- marketAnalysis：只依据提供的大盘行情上下文，详细说明指数涨跌、当前状态、ORB、斐波那契和新闻。数据缺失就明确写缺失，禁止使用记忆补充点位。
- sentimentVsMarket：比较群聊情绪与真实大盘表现是一致、滞后还是背离，并说明依据。
- marketOutlook：推演接下来一个交易时段最可能的行情方向。必须包含主情景、判断依据、情景失效条件和高/中/低置信度；可以判断延续、震荡或反转风险，但不能把极端情绪机械地当作反向信号。数据不足时明确给出低置信度，不得编造行情或点位。
- riskWarning：只提示数据、情绪一致性和市场波动风险，不给具体买卖、反向、仓位或目标点位建议。

${NO_FABRICATION}

summary 用 2-3 句话综合今天 JST 09:00 截至当前的群聊与大盘状态。所有内容仅用于观察，不构成投资建议。`;

  const json = await chatJSON<Omit<DailySummaryResult, "label">>(
    system,
    `【今日消息统计】\n${statsContext}\n\n【大盘行情上下文】\n${marketContext}\n\n【今天 JST 09:00 截至当前的群消息，共 ${messages.length} 条】\n${formatted}`,
    6000,
    DAILY_SUMMARY_SCHEMA as unknown as Record<string, unknown>,
    "deep",
  );
  const score = clampNumber(json.score, -1, 1);
  return {
    score,
    heat: clampNumber(json.heat, 0, 1),
    heatDriver: coerceHeatDriver(json.heatDriver),
    label: scoreLabel(score),
    dominantEmotion: json.dominantEmotion ?? "",
    discussionSummary: json.discussionSummary ?? "",
    marketAnalysis: json.marketAnalysis ?? "",
    sentimentVsMarket: json.sentimentVsMarket ?? "",
    marketOutlook: json.marketOutlook ?? "",
    hotTopics: Array.isArray(json.hotTopics) ? json.hotTopics.slice(0, 5) : [],
    riskWarning: json.riskWarning ?? "",
    summary: json.summary ?? "",
  };
}

async function safeBuildMarketContext(
  messages: { text: string }[],
): Promise<string> {
  try {
    return await buildMarketContext(messages);
  } catch (err) {
    console.error("行情上下文构建失败，已降级:", err);
    return "行情上下文构建失败；禁止编造当前价、新闻、支撑位、压力位、目标价。";
  }
}

async function safeBuildAssetMarketContext(asset: AssetInfo): Promise<string> {
  try {
    return await buildAssetMarketContext(asset);
  } catch (err) {
    console.error(
      `单票行情上下文构建失败 ${asset.nickname}(${asset.ticker}):`,
      err,
    );
    return `${asset.nickname}/${asset.name}(${asset.ticker}, ${asset.exchange})：行情上下文构建失败，禁止编造当前价、新闻、支撑位、压力位、目标价。`;
  }
}

export interface PanicEvent {
  type: "鬼叫" | "炫耀";
  quote: string;
  side: "多" | "空" | "不明";
  intensity: "轻微" | "中等" | "强烈" | "极端";
}

export interface PanicRankEntry {
  username: string;
  score: number; // 加权情绪总分
  panicCount: number; // 鬼叫次数
  hypeCount: number; // 炫耀次数
  topQuote: string; // 最具代表性的一句
  label: string; // 称号，如"爆仓王"、"炫耀大师"
}

export interface PanicHypeResult {
  oneLiner: string; // 一句话人话结论
  panicIndex: number; // 0-100：交易相关的鬼叫/炫耀越强越高
  heat: number; // 0-100：全部群消息的群体烈度
  heatDriver: HeatDriver;
  stabilityScore: number; // 0-100：越高越稳定
  stabilityLabel: "极不稳定" | "不稳定" | "一般" | "较稳定" | "非常稳定";
  panicCount: number; // 鬼叫人数
  hypeCount: number; // 炫耀人数
  longBias: number; // 做多讨论占比 0-100
  shortBias: number; // 做空讨论占比 0-100
  dominantSide: "多" | "空" | "均衡";
  events: PanicEvent[]; // 具体鬼叫/炫耀事件列表
  phaseAnalysis: string; // 盘中阶段分析（开盘/拉升/震荡/跳水/尾盘）
  crowdBehavior: string; // 群体行为特征（抱团、互相喊单、各自为战等）
  summary: string; // 整体总结（3-4句）
  warning: string; // 风险提示
  marketOutlook: string; // 基于真实行情和群体情绪的条件式推演
  leaderboard: PanicRankEntry[]; // 鬼叫排行榜，按score降序
}

const PANIC_SCHEMA = {
  type: "object",
  properties: {
    oneLiner: { type: "string" },
    panicIndex: { type: "integer", description: "0-100" },
    heat: { type: "integer", description: "0-100" },
    heatDriver: HEAT_DRIVER_SCHEMA,
    panicCount: { type: "integer" },
    hypeCount: { type: "integer" },
    longBias: { type: "integer", description: "0-100" },
    shortBias: { type: "integer", description: "0-100" },
    events: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["鬼叫", "炫耀"] },
          quote: { type: "string", description: "原文片段，≤40 字" },
          side: { type: "string", enum: ["多", "空", "不明"] },
          intensity: { type: "string", enum: ["轻微", "中等", "强烈", "极端"] },
        },
        required: ["type", "quote", "side", "intensity"],
        additionalProperties: false,
      },
    },
    phaseAnalysis: { type: "string" },
    crowdBehavior: { type: "string" },
    summary: { type: "string" },
    warning: { type: "string" },
    marketOutlook: { type: "string" },
    leaderboard: {
      type: "array",
      items: {
        type: "object",
        properties: {
          username: { type: "string" },
          score: { type: "integer" },
          panicCount: { type: "integer" },
          hypeCount: { type: "integer" },
          topQuote: { type: "string" },
          label: { type: "string" },
        },
        required: ["username", "score", "panicCount", "hypeCount", "topQuote", "label"],
        additionalProperties: false,
      },
    },
  },
  required: [
    "oneLiner", "panicIndex", "heat", "heatDriver", "panicCount", "hypeCount", "longBias",
    "shortBias", "events", "phaseAnalysis", "crowdBehavior", "summary", "warning",
    "marketOutlook", "leaderboard",
  ],
  additionalProperties: false,
} as const;

interface RawPanic {
  oneLiner: string;
  panicIndex: number;
  heat: number;
  heatDriver: string;
  panicCount: number;
  hypeCount: number;
  longBias: number;
  shortBias: number;
  events: PanicEvent[];
  phaseAnalysis: string;
  crowdBehavior: string;
  summary: string;
  warning: string;
  marketOutlook: string;
  leaderboard: PanicRankEntry[];
}

export async function analyzePanicHype(
  messages: { username: string; text: string }[],
  marketContext = "未提供大盘行情；禁止编造指数点位、涨跌幅或技术位置。",
  statsContext = "",
): Promise<PanicHypeResult> {
  const formatted = messages.map((m) => `@${m.username}: ${m.text}`).join("\n");
  const system = `你是专业的散户群聊行为分析师，也是一位表达自然、有观察力的财经编辑。你擅长从聊天记录中识别极端情绪行为，并结合真实大盘行情判断市场状态。

本报告只分析今天 JST 09:00 截至统计时刻的数据。鬼叫指数与群体烈度是两个不同指标，不得混为一谈。

${NO_JUDGMENT}
（排行榜的 label 是基于行为的中性称号，描述行为不嘲讽人。）

━━━ 表达风格 ━━━
- oneLiner：用一句自然的“人话”讲清鬼叫指数、全群烈度和主导方向之间最重要的关系，30~60字；不要写成研报摘要。
- phaseAnalysis、crowdBehavior 和 summary 要像一个懂市场的人在复盘群聊：句式有长有短，结论具体，允许使用一两个贴切的口语表达或轻微比喻，例如“空方接管了麦克风”“情绪跑在逻辑前面”。不要堆梗，不要起综艺式标题，不要使用“今日片名”“天气预报”“下一集”等包装。
- 每段先说观察，再说这意味着什么；避免连续使用“呈现、构成、处于、整体、明显、主要由”等报告腔词汇。
- 趣味来自准确观察，不来自嘲笑亏损者。不得点名、引用代表性发言或输出个人榜单内容到 oneLiner 及正文分析。
- 事实、指标和因果必须严谨；不要为了好笑编造行情、事件或群体共识。

━━━ 时间与事实边界 ━━━
- 严格服从【消息统计】中的截止时刻。截止时刻在午间时，不得描写“午后”；未到尾盘时，不得描写“尾盘”；不得把未来推演写成已经发生。
- 群聊中提到的新闻、诉讼、财报等只能表述为“群内讨论/消息称”，除非【大盘行情上下文】明确证实。不得把聊天传言升级为已核实事实。

━━━ 鬼叫指数：只看交易情绪爆发 ━━━
识别鬼叫、炫耀和排行榜时，只分析纯情绪化的交易发言，忽略以下内容：
- 技术分析、K线形态、支撑压力位讨论
- 基本面分析、财报、新闻解读
- 平静的问答、价格询问、一般闲聊
- 有理有据的看涨/看跌判断（附带逻辑的不算）
只有纯粹的情绪爆发才计入——"亏死了""赚麻了""完了"这类没有分析内容、纯靠情绪驱动的发言。
普通争吵、骂人或与股票无关的激动发言可以提高 heat，但绝不能计入 panicIndex、panicCount、hypeCount 或排行榜。

━━━ 鬼叫识别权重（亏损引发的极端反应）━━━
【权重×3 极端】纯粹抱怨+大量情绪符号叠加：如"草草草！！！亏死了😭😭"、"完了完了！！卧槽！！"、"AAAA跌死我了"、爆仓/追保/强平+骂人
【权重×2 强烈】纯抱怨无分析：亏麻了、心态崩了、血亏、割肉跑路、"怎么还跌！"、大量感叹号或哭脸
【权重×1 中等】带情绪的陈述：又跌了、难受、后悔没走、跌跌不休、止损了

情绪符号加权规则（叠加到基础权重上）：
- 3个以上感叹号：+1权重
- 😭🤡💀😤😡等强烈情绪emoji（每出现≥2个）：+1权重
- AAAA/草草草/卧槽卧槽等重复感叹词：+1权重
- 以上叠加最高+2权重

${selfMockeryRule("heat 至少按 61~80 的高烈度档计")}
- 自嘲/调侃式的亏损表达（躺板板、团灭、腰斩、挂跌停+苦笑表情）同样按其情绪强度计入鬼叫权重，不因调侃语气降档。

━━━ 炫耀识别权重━━━
【权重×3 极端】纯炫耀+情绪符号：赚麻了+😂😂、嘲讽别人亏钱、翻倍+大量感叹号
【权重×2 强烈】纯炫耀无分析：赚麻了、暴赚、飞了、晒截图
【权重×1 中等】一般炫耀：小赚、回本了、稳了、涨停打到了

━━━ 多空方向判断 ━━━
做多：买入/买了/抄底/加仓/现货/long/多单/看涨/死扛
做空：做空/空单/short/put/卖空/看跌/对冲/跌了赚钱/空赢了
不明：没有方向信息或泛泛抱怨

━━━ 两个强度指标 ━━━
- panicIndex（0~100）：只衡量交易相关鬼叫与炫耀的广度和强度。少数人重复刷屏不能等同于全群失控；参与人数越广、措辞越极端才越高。
- heat（0~100）：观察全部消息的群体烈度，包括与股票无关的争吵。消息多不等于烈度高，必须根据实际措辞判断。
${HEAT_DRIVER_RULES}
- 参考区间：0~20 平静，21~40 局部波动，41~60 明显升温，61~80 高烈度，81~100 群体失控。
- events数组：只记录有明显情绪爆发的消息，每条quote截取最能体现情绪的原文片段(≤40字)

━━━ 行情与推演 ━━━
- phaseAnalysis：描述消息顺序中鬼叫/炫耀情绪如何演变，不得仅凭聊天编造真实指数的开盘、拉升、跳水或尾盘路径。
- marketOutlook：只依据提供的大盘行情和群体情绪，推演接下来一个交易时段的主情景；必须包含依据、失效条件和高/中/低置信度。极端情绪只能作为风险因子，不能机械地当成反向信号，也不能给出买卖、仓位或目标点位建议。
- warning：提示数据覆盖、单一群体样本、行情波动或情绪误判风险。

stabilityScore、stabilityLabel 和 dominantSide 由程序计算，不需要返回。`;

  try {
    const json = await chatJSON<RawPanic>(
      system,
      `【消息统计】\n${statsContext || `消息数：${messages.length}`}\n\n【大盘行情上下文】\n${marketContext}\n\n【今天 JST 09:00 截至统计时刻的群消息，共 ${messages.length} 条】\n${formatted}`,
      16000,
      PANIC_SCHEMA as unknown as Record<string, unknown>,
    );
    const metrics = derivePanicMetrics(
      json.panicIndex,
      json.heat,
      json.longBias,
      json.shortBias,
    );
    const participantCount = new Set(
      messages.map((message) => message.username),
    ).size;
    const normalizePeopleCount = (value: unknown): number => {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) return 0;
      return Math.min(participantCount, Math.max(0, Math.round(numeric)));
    };

    return {
      oneLiner: typeof json.oneLiner === "string" ? json.oneLiner : "",
      panicIndex: metrics.panicIndex,
      heat: metrics.heat,
      heatDriver: coerceHeatDriver(json.heatDriver),
      stabilityScore: metrics.stabilityScore,
      stabilityLabel: metrics.stabilityLabel,
      panicCount: normalizePeopleCount(json.panicCount),
      hypeCount: normalizePeopleCount(json.hypeCount),
      longBias: metrics.longBias,
      shortBias: metrics.shortBias,
      dominantSide: metrics.dominantSide,
      events: Array.isArray(json.events) ? json.events : [],
      phaseAnalysis: json.phaseAnalysis ?? "",
      crowdBehavior: json.crowdBehavior ?? "",
      summary: json.summary ?? "",
      warning: json.warning ?? "",
      marketOutlook: json.marketOutlook ?? "",
      leaderboard: Array.isArray(json.leaderboard) ? json.leaderboard : [],
    };
  } catch (e) {
    console.error("鬼叫指数分析失败：", e);
    return {
      oneLiner: "本期分析未成功生成，先不让沉默的数据强行开口。",
      panicIndex: 0,
      heat: 0,
      heatDriver: "其他或不明",
      stabilityScore: 50,
      stabilityLabel: "一般",
      panicCount: 0,
      hypeCount: 0,
      longBias: 50,
      shortBias: 50,
      dominantSide: "均衡",
      events: [],
      phaseAnalysis: "",
      crowdBehavior: "",
      summary: "分析失败",
      warning: "数据异常",
      marketOutlook: "数据不足，无法推演。",
      leaderboard: [],
    };
  }
}

export interface BombResult {
  bombIndex: number; // 0-100：越高越亢奋（危险）
  fearIndex: number; // 0-100：越高越恐慌（机会）
  signal: "强烈卖出" | "减仓" | "观望" | "加仓" | "强烈买入";
  signalEmoji: string;
  mood: string; // 当前情绪状态描述
  keyMessages: string[]; // 最能体现情绪的发言（不超过5条）
  summary: string; // 整体分析（3-4句）
  action: string; // 具体操作建议
  reasoning: string; // 逆向逻辑说明
}

const BOMB_SCHEMA = {
  type: "object",
  properties: {
    bombIndex: { type: "integer", description: "0-100" },
    fearIndex: { type: "integer", description: "0-100" },
    signal: { type: "string", enum: ["强烈卖出", "减仓", "观望", "加仓", "强烈买入"] },
    signalEmoji: { type: "string", description: "🔴/🟠/⚪/🟢/💚 之一" },
    mood: { type: "string" },
    keyMessages: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
    action: { type: "string" },
    reasoning: { type: "string" },
  },
  required: [
    "bombIndex", "fearIndex", "signal", "signalEmoji", "mood", "keyMessages",
    "summary", "action", "reasoning",
  ],
  additionalProperties: false,
} as const;

export async function analyzeBombUser(
  messages: { text: string; time: string }[],
  username: string,
): Promise<BombResult> {
  const formatted = messages.map((m) => `[${m.time}] ${m.text}`).join("\n");
  const system = `你是一个专门研究"反向指标用户"的分析师。

目标用户：@${username}
这个用户是群里的典型散户情绪风向标——他极度亢奋时往往是市场顶部信号，他极度恐慌割肉时往往是市场底部信号。
只描述该用户的情绪状态与强度，不评价他的能力、智商、性格。

你的任务：
1. 分析该用户今日发言的情绪状态
2. 计算"炸弹指数"（亢奋程度）和"恐慌指数"
3. 给出反向操作建议

【炸弹指数（亢奋）识别】
极端亢奋（80-100）：梭哈、all-in、必涨、买爆、大量感叹号+看涨、嘲讽空头、翻倍了还加仓
强烈亢奋（60-80）：赚麻了、飞了、涨涨涨、大量买入、炫耀收益
一般亢奋（40-60）：偏乐观、小赚、看涨
平静（0-40）：理性讨论或无情绪

【恐慌指数识别】
极端恐慌（80-100）：爆仓、割肉跑路、完了完了、亏死了+哭脸、跑路宣言
强烈恐慌（60-80）：亏麻了、心态崩了、血亏、后悔加仓
一般恐慌（40-60）：难受、跌跌不休、止损了

【操作信号逻辑（反向）】
- 用户极度亢奋（bombIndex≥80）→ 强烈卖出
- 用户强烈亢奋（bombIndex 60-80）→ 减仓
- 用户极度恐慌（fearIndex≥80）→ 强烈买入
- 用户强烈恐慌（fearIndex 60-80）→ 加仓
- 其他 → 观望

keyMessages：挑出最能体现该用户今日情绪的原话（≤5条，≤40字/条），不要带用户名。
summary：3-4句整体分析，重点说明情绪依据。action：具体操作建议（仓位、时机）。reasoning：逆向逻辑说明（为什么反向操作）。`;

  const clamp = (v: number) => clampNumber(v, 0, 100);
  try {
    const json = await chatJSON<BombResult>(
      system,
      `以下是 @${username} 今日全部发言：\n\n${formatted}`,
      4000,
      BOMB_SCHEMA as unknown as Record<string, unknown>,
    );
    return {
      bombIndex: clamp(json.bombIndex),
      fearIndex: clamp(json.fearIndex),
      signal: json.signal,
      signalEmoji: json.signalEmoji || "⚪",
      mood: json.mood ?? "",
      keyMessages: Array.isArray(json.keyMessages) ? json.keyMessages : [],
      summary: json.summary ?? "",
      action: json.action ?? "",
      reasoning: json.reasoning ?? "",
    };
  } catch (e) {
    console.error("炸弹指数分析失败：", e);
    return {
      bombIndex: 0,
      fearIndex: 0,
      signal: "观望",
      signalEmoji: "⚪",
      mood: "分析失败",
      keyMessages: [],
      summary: "分析失败",
      action: "",
      reasoning: "",
    };
  }
}

// ── 单个用户发言追踪：提取他提到的股票与观点，再结合行情做逐票分析 ──

export type UserStance = "看多" | "看空" | "观望" | "中性";

export interface UserStockMention extends AssetInfo {
  stance: UserStance;
  hisView: string; // 他对该股票说了什么（客观转述）
  quotes: string[]; // 相关原话，≤3 条
  analysis: string; // 结合行情的分析；未做行情分析时为空
}

export interface UserStockReport {
  mood: string;
  summary: string;
  otherTopics: string[];
  stocks: UserStockMention[];
}

const USER_STANCES: UserStance[] = ["看多", "看空", "观望", "中性"];
const USER_REPORT_MAX_STOCKS = 6;
const USER_REPORT_MARKET_STOCKS = 3;

const USER_STOCKS_SCHEMA = {
  type: "object",
  properties: {
    mood: { type: "string", description: "一句话描述他这段时间的情绪状态" },
    summary: { type: "string", description: "2-3 句概括他的主要观点" },
    otherTopics: { type: "array", items: { type: "string" } },
    stocks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          nickname: { type: "string", description: "他的叫法" },
          name: { type: "string", description: "正式名称" },
          ticker: { type: "string", description: "代码或未知" },
          exchange: { type: "string", description: "交易所或未知" },
          stance: { type: "string", enum: ["看多", "看空", "观望", "中性"] },
          hisView: { type: "string", description: "他对该标的的观点转述" },
          quotes: { type: "array", items: { type: "string" } },
        },
        required: ["nickname", "name", "ticker", "exchange", "stance", "hisView", "quotes"],
        additionalProperties: false,
      },
    },
  },
  required: ["mood", "summary", "otherTopics", "stocks"],
  additionalProperties: false,
} as const;

const USER_ANALYSES_SCHEMA = {
  type: "object",
  properties: {
    analyses: {
      type: "array",
      items: {
        type: "object",
        properties: {
          ticker: { type: "string", description: "与输入一致" },
          analysis: { type: "string" },
        },
        required: ["ticker", "analysis"],
        additionalProperties: false,
      },
    },
  },
  required: ["analyses"],
  additionalProperties: false,
} as const;

interface RawUserStocks {
  mood: string;
  summary: string;
  otherTopics: string[];
  stocks: {
    nickname: string;
    name: string;
    ticker: string;
    exchange: string;
    stance: string;
    hisView: string;
    quotes: string[];
  }[];
}

export async function analyzeUserStocks(
  messages: { time: string; text: string }[],
  displayName: string,
): Promise<UserStockReport> {
  const formatted = messages.map((m) => `[${m.time}] ${m.text}`).join("\n");
  const hints = assetHints();
  const extractSystem = `你是股票讨论整理助手。下面是群成员「${displayName}」在一段时间内的全部发言，请整理他提到的股票/指数/ETF/商品及其观点。

【要求】
- 只客观转述他说了什么、对标的是什么态度，不评价这个人的能力、智商、性格或可信度。
- stance 只能是：看多、看空、观望、中性。没有明确倾向就写中性。
- 尽量给出 ticker 和 exchange：日股写 4 位代码 + 东京；美股写代码 + NASDAQ/NYSE；指数可写 ^N225 等 Yahoo 代码 + 指数。不确定就写 "未知"，禁止编造。
- 只收录他自己表达过观点或明确提及的标的；纯转发新闻里顺带出现的标的，若他未表态，stance 写中性。
- stocks 按他讨论的重要程度排序，最多 ${USER_REPORT_MAX_STOCKS} 个。
- quotes 选与该标的相关的原话，≤3 条、每条 ≤40 字。
- otherTopics：与股票无关的主要话题，≤5 个短语。
${hints ? `- 群内常用叫法参考：${hints}` : ""}`;

  const json = await chatJSON<RawUserStocks>(
    extractSystem,
    `以下是「${displayName}」的发言（JST 时间）：\n\n${formatted}`,
    4000,
    USER_STOCKS_SCHEMA as unknown as Record<string, unknown>,
    "light",
  );
  const stocks: UserStockMention[] = (Array.isArray(json.stocks) ? json.stocks : [])
    .slice(0, USER_REPORT_MAX_STOCKS)
    .map((s) => ({
      nickname: String(s.nickname || s.name || ""),
      name: String(s.name || s.nickname || ""),
      ticker: String(s.ticker || "未知"),
      exchange: String(s.exchange || "未知"),
      stance: USER_STANCES.includes(s.stance as UserStance) ? (s.stance as UserStance) : "中性",
      hisView: String(s.hisView ?? ""),
      quotes: Array.isArray(s.quotes) ? s.quotes.map(String).slice(0, 3) : [],
      analysis: "",
    }));

  const report: UserStockReport = {
    mood: String(json.mood ?? ""),
    summary: String(json.summary ?? ""),
    otherTopics: Array.isArray(json.otherTopics) ? json.otherTopics.map(String).slice(0, 5) : [],
    stocks,
  };

  const withTicker = stocks.filter((s) => s.ticker && s.ticker !== "未知").slice(0, USER_REPORT_MARKET_STOCKS);
  if (withTicker.length === 0) return report;

  const contexts = await Promise.all(withTicker.map((s) => safeBuildAssetMarketContext(s)));
  const analysisSystem = `你是交易辅助分析器。针对群成员「${displayName}」提到的每个标的，把他的观点和实际行情对照，给出简短分析。

【要求】
- 不评价这个人，只分析标的：他的观点与当前价、涨跌幅、斐波那契、ORB、新闻是否一致，有哪些值得关注的点位或风险。
- 每个标的 2-3 句，结尾给出【偏多/偏空/观望】的客观判断。这不是投资建议。
- ticker 必须与输入一致。

${NO_FABRICATION}`;

  try {
    const parsed = await chatJSON<{ analyses: { ticker: string; analysis: string }[] }>(
      analysisSystem,
      withTicker
        .map((s, i) => [
          `标的 ${i + 1}：${s.nickname}/${s.name}/${s.ticker}/${s.exchange}`,
          `他的态度：${s.stance}；观点：${s.hisView}`,
          `行情上下文：${contexts[i]}`,
        ].join("\n"))
        .join("\n\n"),
      2500,
      USER_ANALYSES_SCHEMA as unknown as Record<string, unknown>,
    );
    const normalizeTicker = (value: string) => value.trim().toUpperCase();
    for (const item of parsed.analyses ?? []) {
      const target = withTicker.find(
        (s) => normalizeTicker(s.ticker) === normalizeTicker(String(item.ticker)),
      );
      if (target) target.analysis = String(item.analysis ?? "");
    }
  } catch (e) {
    console.error("用户发言行情分析失败，已降级为仅观点整理：", e);
  }

  return report;
}

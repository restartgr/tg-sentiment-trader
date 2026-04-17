import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { config } from "./config";

interface AssetConfig {
  nickname: string;
  aliases: string[];
  name: string;
  ticker: string;
  exchange: string;
}

function loadAssetHints(): string {
  const file = path.join(process.cwd(), "assets.json");
  if (!fs.existsSync(file)) return "";
  const assets: AssetConfig[] = JSON.parse(fs.readFileSync(file, "utf-8"));
  return assets
    .map((a) => {
      const allNames = [a.nickname, ...a.aliases].join("/");
      return `${allNames}=${a.name}/${a.ticker}/${a.exchange}`;
    })
    .join("、");
}

// 优先用千问，其次 Anthropic
const USE_QIANWEN = !!config.llm.qianwenKey;

const qianwenClient = USE_QIANWEN
  ? new OpenAI({
      apiKey: config.llm.qianwenKey || process.env.DASHSCOPE_API_KEY,
      baseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    })
  : null;

const anthropicClient = !USE_QIANWEN && config.llm.anthropicKey
  ? new Anthropic({ apiKey: config.llm.anthropicKey })
  : null;

if (!USE_QIANWEN && !anthropicClient) {
  throw new Error("请在 .env 中配置 QIANWEN_API_KEY 或 ANTHROPIC_API_KEY");
}

console.log(`🤖 使用模型：${USE_QIANWEN ? "千问 qwen3.6-plus" : "Claude claude-sonnet-4-6"}`);

async function chat(system: string, user: string, maxTokens: number): Promise<string> {
  if (USE_QIANWEN && qianwenClient) {
    const res = await qianwenClient.chat.completions.create({
      model: "qwen3.6-plus",
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      // @ts-ignore — dashscope 扩展参数，关闭思考过程避免干扰 JSON 解析
      extra_body: { enable_thinking: false },
    });
    return res.choices[0]?.message?.content ?? "";
  }
  // Anthropic
  const res = await anthropicClient!.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: user }],
  });
  const block = res.content[0];
  return block.type === "text" ? block.text : "";
}

function parseJSON(raw: string): any {
  // 去掉 markdown 代码块
  let cleaned = raw.trim().replace(/^```json?\n?/, "").replace(/\n?```$/, "").trim();
  // 截取第一个 { 到最后一个 } 之间的内容，兼容模型在 JSON 前后加说明文字
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start !== -1 && end !== -1) cleaned = cleaned.slice(start, end + 1);
  return JSON.parse(cleaned);
}

export interface SentimentResult {
  score: number; // -1.0 (极度悲观) ~ 1.0 (极度乐观)
  label: "极度悲观" | "悲观" | "中性" | "乐观" | "极度乐观";
  reasoning: string;
}

export async function analyzeSentiment(
  text: string,
  username: string,
): Promise<SentimentResult> {
  const system = `你是散户投机群的情绪分析器。分析消息对股市/加密货币的情感倾向。

评分规则（必须敢给极端分）：
- +0.8 ~ +1.0：强烈看涨。例：all-in、梭哈、必涨、飞了、上车、冲、买爆
- +0.4 ~ +0.8：偏乐观。例：看涨、感觉要涨、可以买点
- -0.2 ~ +0.2：中性或无关。例：纯闲聊、问问题、不涉及市场判断
- -0.4 ~ -0.8：偏悲观。例：感觉要跌、谨慎、观望
- -0.8 ~ -1.0：强烈看跌。例：割肉、跑路、崩了、归零、完蛋、全亏了

注意：散户说话口语化，要理解隐含情绪。"稳了"="极度乐观"，"寄了"="极度悲观"。

只返回JSON，不要任何其他文字：
{"score": 数字, "label": "极度悲观|悲观|中性|乐观|极度乐观", "reasoning": "一句话"}`;

  try {
    const raw = await chat(system, `@${username}：${text}`, 300);
    const json = parseJSON(raw);
    return {
      score: Math.max(-1, Math.min(1, json.score)),
      label: json.label,
      reasoning: json.reasoning,
    };
  } catch {
    return { score: 0, label: "中性", reasoning: "解析失败" };
  }
}

export interface AssetInfo {
  nickname: string; // 群里的叫法，如"大G"、"凯子"
  name: string; // 正式名称，如"奔驰"、"特斯拉"
  ticker: string; // 代码，如"MBGYY"、"TSLA"、"600519"
  exchange: string; // 交易所，如"NYSE"、"NASDAQ"、"上交所"、"期货"
}

export interface BatchAnalysisResult {
  score: number;
  label: "极度悲观" | "悲观" | "中性" | "乐观" | "极度乐观";
  assets: AssetInfo[];
  summary: string;
  signal: string;
}

export async function analyzeBatch(
  messages: { username: string; text: string }[],
): Promise<BatchAnalysisResult> {
  const formatted = messages.map((m) => `@${m.username}: ${m.text}`).join("\n");
  const system = `你是散户投机群的情绪分析器，同时精通全球股票、期货、加密货币的代码和俗称。

分析一批群消息的整体情感倾向，并识别提到的所有金融资产。

评分规则：
- +0.8 ~ +1.0：群体极度亢奋，疯狂看涨
- +0.4 ~ +0.8：整体偏乐观
- -0.2 ~ +0.2：中性或分歧
- -0.4 ~ -0.8：整体偏悲观
- -0.8 ~ -1.0：群体极度恐慌，割肉跑路

assets 字段：识别所有提到的金融资产，包括股票俗称（${loadAssetHints()}、药哥=辉瑞等）、期货代码（ES=标普500期货、NQ=纳指期货）、加密货币、A股代码等。
对每个资产返回：nickname（群里叫法）、name（正式名称）、ticker（交易代码）、exchange（交易所/市场）。
如果不确定代码，ticker 填"未知"。

signal 字段：根据群体情绪质量判断操作方向。
- 若群体情绪极端且一致（羊群效应明显、情绪化、无理由梭哈/割肉）→ 考虑反向操作
- 若群体情绪有理有据（附带基本面/技术面分析、信息优势明显）→ 考虑跟随方向
- 若情绪分歧或中性 → 观望
signal 内容需说明：操作方向（跟随/反向/观望）、理由（一句话）、具体建议。

只返回JSON，不要其他文字：
{"score": 数字, "label": "极度悲观|悲观|中性|乐观|极度乐观", "assets": [{"nickname":"大G","name":"梅赛德斯-奔驰","ticker":"MBGYY","exchange":"OTC"}], "summary": "一句话描述群体情绪", "signal": "【跟随/反向/观望】理由 + 具体建议"}`;

  try {
    const raw = await chat(system, `以下是最近 ${messages.length} 条群消息：\n\n${formatted}`, 800);
    const json = parseJSON(raw);
    return {
      score: Math.max(-1, Math.min(1, json.score)),
      label: json.label,
      assets: Array.isArray(json.assets) ? json.assets : [],
      summary: json.summary,
      signal: json.signal,
    };
  } catch {
    console.error("批量分析失败");
    return { score: 0, label: "中性", assets: [], summary: "解析失败", signal: "" };
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
  score: number;       // 加权情绪总分
  panicCount: number;  // 鬼叫次数
  hypeCount: number;   // 炫耀次数
  topQuote: string;    // 最具代表性的一句
  label: string;       // 称号，如"爆仓王"、"炫耀大师"
}

export interface PanicHypeResult {
  panicIndex: number; // 0-100：越高越混乱
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
  contrarian: string; // 逆向思考建议
  leaderboard: PanicRankEntry[]; // 鬼叫排行榜，按score降序
}

export async function analyzePanicHype(
  messages: { username: string; text: string }[],
): Promise<PanicHypeResult> {
  const formatted = messages.map((m) => `@${m.username}: ${m.text}`).join("\n");
  const system = `你是专业的散户群聊行为分析师，擅长从聊天记录中识别极端情绪行为并判断市场稳定性。

分析时间段为开盘期间（10:00-15:30），聚焦交易行为中的情绪爆发。

【重要原则】只分析纯情绪化发言，忽略以下内容：
- 技术分析、K线形态、支撑压力位讨论
- 基本面分析、财报、新闻解读
- 平静的问答、价格询问、一般闲聊
- 有理有据的看涨/看跌判断（附带逻辑的不算）
只有纯粹的情绪爆发才计入——"亏死了""赚麻了""完了"这类没有分析内容、纯靠情绪驱动的发言。

━━━ 鬼叫识别权重（亏损引发的极端反应）━━━
【权重×3 极端】纯粹抱怨+大量情绪符号叠加：如"草草草！！！亏死了😭😭"、"完了完了！！卧槽！！"、"AAAA跌死我了"、爆仓/追保/强平+骂人
【权重×2 强烈】纯抱怨无分析：亏麻了、心态崩了、血亏、割肉跑路、"怎么还跌！"、大量感叹号或哭脸
【权重×1 中等】带情绪的陈述：又跌了、难受、后悔没走、跌跌不休、止损了

情绪符号加权规则（叠加到基础权重上）：
- 3个以上感叹号：+1权重
- 😭🤡💀😤😡等强烈情绪emoji（每出现≥2个）：+1权重
- AAAA/草草草/卧槽卧槽等重复感叹词：+1权重
- 以上叠加最高+2权重

━━━ 炫耀识别权重━━━
【权重×3 极端】纯炫耀+情绪符号：赚麻了+😂😂、嘲讽别人亏钱、翻倍+大量感叹号
【权重×2 强烈】纯炫耀无分析：赚麻了、暴赚、飞了、晒截图
【权重×1 中等】一般炫耀：小赚、回本了、稳了、涨停打到了

━━━ 多空方向判断 ━━━
做多：买入/买了/抄底/加仓/现货/long/多单/看涨/死扛
做空：做空/空单/short/put/卖空/看跌/对冲/跌了赚钱/空赢了
不明：没有方向信息或泛泛抱怨

━━━ 稳定性逻辑 ━━━
- 多人爆仓/割肉(鬼叫强烈) → 极不稳定，底部信号或恐慌蔓延
- 多人炫耀暴赚(炫耀强烈) → 不稳定，泡沫/顶部信号
- 鬼叫+炫耀同时出现 → 单边行情，分化严重，不稳定
- 讨论以技术面/基本面为主，情绪平稳 → 较稳定
- events数组：只记录有明显情绪爆发的消息，每条quote截取最能体现情绪的原文片段(≤40字)

━━━ 鬼叫排行榜 ━━━
leaderboard：统计每个有情绪发言的用户，最多返回10人，按情绪强度综合排名（强烈鬼叫/炫耀权重更高）。
给每人起一个贴切称号，例如：爆仓王、割肉侠、炫耀大师、韭菜精、空头刺客、死扛侠、恐慌大叔等。
topQuote取该用户最具代表性的一句情绪发言（≤30字）。

只返回JSON，不要其他文字：
{"panicIndex":0-100整数,"stabilityScore":0-100整数,"stabilityLabel":"极不稳定|不稳定|一般|较稳定|非常稳定","panicCount":整数,"hypeCount":整数,"longBias":0-100整数,"shortBias":0-100整数,"dominantSide":"多|空|均衡","events":[{"type":"鬼叫|炫耀","quote":"原文片段","side":"多|空|不明","intensity":"轻微|中等|强烈"}],"phaseAnalysis":"描述今日盘中节奏（2句）","crowdBehavior":"描述群体行为特征（1句）","summary":"整体总结（3-4句，包含多空主导、情绪强度、典型行为）","warning":"风险提示（1句）","contrarian":"逆向操作建议（1句，基于鬼叫/炫耀程度判断）","leaderboard":[{"username":"用户名","score":整数,"panicCount":整数,"hypeCount":整数,"topQuote":"最具代表性一句","label":"称号"}]}`;

  const clamp = (v: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
  try {
    const raw = await chat(system, `分析以下 ${messages.length} 条开盘期间群消息，输出鬼叫指数报告：\n\n${formatted}`, 8000);
    console.log("📥 原始返回（前300字）：", raw.slice(0, 300));
    const json = parseJSON(raw);
    return {
      panicIndex: clamp(json.panicIndex),
      stabilityScore: clamp(json.stabilityScore),
      stabilityLabel: json.stabilityLabel,
      panicCount: json.panicCount ?? 0,
      hypeCount: json.hypeCount ?? 0,
      longBias: clamp(json.longBias),
      shortBias: clamp(json.shortBias),
      dominantSide: json.dominantSide ?? "均衡",
      events: Array.isArray(json.events) ? json.events : [],
      phaseAnalysis: json.phaseAnalysis ?? "",
      crowdBehavior: json.crowdBehavior ?? "",
      summary: json.summary ?? "",
      warning: json.warning ?? "",
      contrarian: json.contrarian ?? "",
      leaderboard: Array.isArray(json.leaderboard) ? json.leaderboard : [],
    };
  } catch (e) {
    console.error("鬼叫指数解析失败：", e);
    return {
      panicIndex: 0, stabilityScore: 50, stabilityLabel: "一般",
      panicCount: 0, hypeCount: 0, longBias: 50, shortBias: 50,
      dominantSide: "均衡", events: [], phaseAnalysis: "",
      crowdBehavior: "", summary: "解析失败", warning: "数据异常", contrarian: "",
      leaderboard: [],
    };
  }
}

export function checkExtreme(
  scores: number[],
  threshold: number,
): {
  isExtreme: boolean;
  avgScore: number;
  direction: "bullish" | "bearish" | null;
} {
  if (scores.length === 0)
    return { isExtreme: false, avgScore: 0, direction: null };

  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;

  if (avg >= threshold) {
    return { isExtreme: true, avgScore: avg, direction: "bullish" };
  }
  if (avg <= -threshold) {
    return { isExtreme: true, avgScore: avg, direction: "bearish" };
  }
  return { isExtreme: false, avgScore: avg, direction: null };
}

import Anthropic from "@anthropic-ai/sdk";
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

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

export interface SentimentResult {
  score: number; // -1.0 (极度悲观) ~ 1.0 (极度乐观)
  label: "极度悲观" | "悲观" | "中性" | "乐观" | "极度乐观";
  reasoning: string;
}

export async function analyzeSentiment(
  text: string,
  username: string,
): Promise<SentimentResult> {
  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 200,
    system: `你是散户投机群的情绪分析器。分析消息对股市/加密货币的情感倾向。

评分规则（必须敢给极端分）：
- +0.8 ~ +1.0：强烈看涨。例：all-in、梭哈、必涨、飞了、上车、冲、买爆
- +0.4 ~ +0.8：偏乐观。例：看涨、感觉要涨、可以买点
- -0.2 ~ +0.2：中性或无关。例：纯闲聊、问问题、不涉及市场判断
- -0.4 ~ -0.8：偏悲观。例：感觉要跌、谨慎、观望
- -0.8 ~ -1.0：强烈看跌。例：割肉、跑路、崩了、归零、完蛋、全亏了

注意：散户说话口语化，要理解隐含情绪。"稳了"="极度乐观"，"寄了"="极度悲观"。

只返回JSON，不要任何其他文字：
{"score": 数字, "label": "极度悲观|悲观|中性|乐观|极度乐观", "reasoning": "一句话"}`,
    messages: [
      {
        role: "user",
        content: `@${username}：${text}`,
      },
    ],
  });

  const content = response.content[0];
  if (content.type !== "text") throw new Error("Unexpected response type");

  // 兼容 Claude 返回 markdown 代码块的情况
  const raw = content.text
    .trim()
    .replace(/^```json?\n?/, "")
    .replace(/\n?```$/, "")
    .trim();

  try {
    const json = JSON.parse(raw);
    return {
      score: Math.max(-1, Math.min(1, json.score)),
      label: json.label,
      reasoning: json.reasoning,
    };
  } catch {
    console.error("JSON 解析失败，原始返回：", raw);
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

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 600,
    system: `你是散户投机群的情绪分析器，同时精通全球股票、期货、加密货币的代码和俗称。

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
{"score": 数字, "label": "极度悲观|悲观|中性|乐观|极度乐观", "assets": [{"nickname":"大G","name":"梅赛德斯-奔驰","ticker":"MBGYY","exchange":"OTC"}], "summary": "一句话描述群体情绪", "signal": "【跟随/反向/观望】理由 + 具体建议"}`,
    messages: [
      {
        role: "user",
        content: `以下是最近 ${messages.length} 条群消息：\n\n${formatted}`,
      },
    ],
  });

  const content = response.content[0];
  if (content.type !== "text") throw new Error("Unexpected response type");

  const raw = content.text
    .trim()
    .replace(/^```json?\n?/, "")
    .replace(/\n?```$/, "")
    .trim();
  try {
    const json = JSON.parse(raw);
    return {
      score: Math.max(-1, Math.min(1, json.score)),
      label: json.label,
      assets: Array.isArray(json.assets) ? json.assets : [],
      summary: json.summary,
      signal: json.signal,
    };
  } catch {
    console.error("批量分析 JSON 解析失败：", raw);
    return {
      score: 0,
      label: "中性",
      assets: [],
      summary: "解析失败",
      signal: "",
    };
  }
}

export interface PanicEvent {
  type: "鬼叫" | "炫耀";
  quote: string; // 原文片段（最多40字）
  side: "多" | "空" | "不明";
  intensity: "轻微" | "中等" | "强烈";
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
}

export async function analyzePanicHype(
  messages: { username: string; text: string }[],
): Promise<PanicHypeResult> {
  const formatted = messages.map((m) => `@${m.username}: ${m.text}`).join("\n");

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 5000,
    system: `你是专业的散户群聊行为分析师，擅长从聊天记录中识别极端情绪行为并判断市场稳定性。

分析时间段为开盘期间（13:30-15:30），聚焦交易行为中的情绪爆发。

━━━ 鬼叫识别（亏损引发的极端反应）━━━
强烈信号：爆仓、追保、强平、被扫、全亏了、一夜回到解放前、跌死我了、完了完了、割肉跑路、快撑不住
中等信号：亏麻了、心态崩了、怎么跌这么快、我的止损、血亏、心碎了、后悔没走
轻微信号：又跌了、难受、怎么回事、跌跌不休
情绪符号：大量感叹号、哭脸emoji、AAAA、"？？？"连续、骂人

━━━ 炫耀识别（盈利引发的夸张炫耀）━━━
强烈信号：赚麻了、翻倍了、飞升、暴赚、直接赢了、晒截图配文"就这"、嘲讽别人亏钱
中等信号：今天稳了、小赚、回本了、涨停打到了、赚够了跑路
轻微信号：还行、凑合、不亏就行

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

只返回JSON，不要其他文字：
{
  "panicIndex": 0-100整数,
  "stabilityScore": 0-100整数,
  "stabilityLabel": "极不稳定|不稳定|一般|较稳定|非常稳定",
  "panicCount": 整数,
  "hypeCount": 整数,
  "longBias": 0-100整数,
  "shortBias": 0-100整数,
  "dominantSide": "多|空|均衡",
  "events": [{"type":"鬼叫|炫耀","quote":"原文片段","side":"多|空|不明","intensity":"轻微|中等|强烈"}],
  "phaseAnalysis": "描述今日盘中节奏（2句）",
  "crowdBehavior": "描述群体行为特征（1句）",
  "summary": "整体总结（3-4句，包含多空主导、情绪强度、典型行为）",
  "warning": "风险提示（1句）",
  "contrarian": "逆向操作建议（1句，基于鬼叫/炫耀程度判断）"
}`,
    messages: [
      {
        role: "user",
        content: `分析以下 ${messages.length} 条开盘期间群消息，输出鬼叫指数报告：\n\n${formatted}`,
      },
    ],
  });

  const content = response.content[0];
  if (content.type !== "text") throw new Error("Unexpected response type");

  const raw = content.text
    .trim()
    .replace(/^```json?\n?/, "")
    .replace(/\n?```$/, "")
    .trim();
  try {
    const json = JSON.parse(raw);
    const clamp = (v: number, lo = 0, hi = 100) =>
      Math.max(lo, Math.min(hi, v));
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
    };
  } catch {
    console.error("鬼叫指数 JSON 解析失败：", raw);
    return {
      panicIndex: 0,
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
      summary: "解析失败",
      warning: "数据异常，请检查",
      contrarian: "",
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

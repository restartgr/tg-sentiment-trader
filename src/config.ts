import dotenv from "dotenv";
import { DEFAULT_ROUTING_THRESHOLDS } from "./routing";
dotenv.config();

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required env variable: ${key}`);
  return value;
}

function parseList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseIntEnv(key: string, defaultValue?: number): number {
  const raw = process.env[key] ?? defaultValue?.toString();
  if (!raw) throw new Error(`Missing required env variable: ${key}`);

  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) {
    throw new Error(`Invalid integer env variable: ${key}`);
  }
  return value;
}

function parseFloatEnv(key: string, defaultValue: number): number {
  const value = Number.parseFloat(process.env[key] ?? defaultValue.toString());
  if (Number.isNaN(value)) {
    throw new Error(`Invalid number env variable: ${key}`);
  }
  return value;
}

export const config = {
  telegram: {
    apiId: parseIntEnv("TG_API_ID"),
    apiHash: requireEnv("TG_API_HASH"),
    // 要监控的群组 username 或 invite link（支持多个）
    targetGroups: parseList(requireEnv("TG_TARGET_GROUPS")),
    // 你自己的 Telegram user ID（用于接收提醒）
    myUserId: parseIntEnv("TG_MY_USER_ID"),
    bombTarget: process.env.TG_BOMB_TARGET ?? "",
    // 实时告警 bot（@BotFather 创建）；留空则告警退回「已保存消息」。
    // 需先在 TG 里给 bot 发一次 /start，bot 才能私聊你（chat_id 即 TG_MY_USER_ID）。
    botToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
    // 发言追踪：要单独追踪的群成员数字 user ID（逗号分隔），用于 pnpm user-report
    watchUserIds: parseList(process.env.TG_WATCH_USER_IDS ?? ""),
    // 监听进程内触发发言追踪的 cron（JST），例如 "0 12 * * 1-5"；留空不启用
    userReportCron: process.env.USER_REPORT_CRON ?? "",
    // 是否把自己的发言从情绪分析里剔除（默认剔除，设 TG_EXCLUDE_SELF=false 关闭）
    excludeSelf: (process.env.TG_EXCLUDE_SELF ?? "true").toLowerCase() !== "false",
  },
  llm: {
    apiKey: requireEnv("ANTHROPIC_API_KEY"),
    // 模型分层：light 跑高频的轻量评分，deep 跑重要的深度分析。
    // Haiku 在首轮情绪评分上偏差过大，light 默认也使用 Sonnet 5（可经 env 覆盖）。
    modelLight: process.env.MODEL_LIGHT ?? "claude-sonnet-5",
    modelDeep: process.env.MODEL_DEEP ?? "claude-sonnet-5",
    // 实时告警的深度分析与单票分析：触发少、最需要判断力，默认用 Opus 5.5。
    modelAlert: process.env.MODEL_ALERT ?? "claude-opus-5-5",
  },
  report: {
    // 今日综合总结固定观察的大盘标的，直接使用 Yahoo Finance symbol。
    benchmarks: parseList(process.env.REPORT_BENCHMARKS ?? "^N225"),
  },
  sentiment: {
    // 情感分析触发条件：连续 N 条消息的平均分超过阈值
    batchSize: parseIntEnv("SENTIMENT_BATCH_SIZE", 20),
    // 简单分析档：>= 此值进入深度分析（但不调实时行情），< 此值仅发轻量总览
    simpleAnalysisMinAbsScore: parseFloatEnv(
      "SIMPLE_ANALYSIS_MIN_ABS_SCORE",
      DEFAULT_ROUTING_THRESHOLDS.scoreMin,
    ),
    // 监控档：>= 此值的深度分析会调取实时行情/斐波/ORB
    monitorMinAbsScore: parseFloatEnv("MONITOR_MIN_ABS_SCORE", 0.6),
    // 烈度触发深度分析：heat >= 此值即使 score 中性也进 Deep（与 score 阈值独立）。
    // 只表示"进入 Deep 去理解"，不代表要推送、更不代表可交易。
    heatDeepThreshold: parseFloatEnv(
      "HEAT_DEEP_THRESHOLD",
      DEFAULT_ROUTING_THRESHOLDS.heatDeepMin,
    ),
    // 纯烈度告警的推送门槛：finalHeat >= 此值才推送"情绪过热"摘要（低于则只落库+日志）。
    heatPushThreshold: parseFloatEnv("HEAT_PUSH_THRESHOLD", 0.8),
    // 实时告警门槛：深度复核后 |score| >= 此值或 heat >= ALERT_MIN_HEAT 才推送，其余只落库。
    alertMinAbsScore: parseFloatEnv("ALERT_MIN_ABS_SCORE", 0.8),
    alertMinHeat: parseFloatEnv("ALERT_MIN_HEAT", 0.85),
    // 同一个群的告警冷却（分钟）；冷却期内强度比上次高出 ALERT_ESCALATION_DELTA 才再推。
    alertCooldownMinutes: parseFloatEnv("ALERT_COOLDOWN_MINUTES", 30),
    alertEscalationDelta: parseFloatEnv("ALERT_ESCALATION_DELTA", 0.05),
    // 提及量异动：近 N 分钟被提次数 >= MIN_COUNT 且 >= 平时同长度窗口的 RATIO 倍才推送
    mentionWindowMinutes: parseFloatEnv("MENTION_WINDOW_MINUTES", 30),
    mentionLookbackDays: parseFloatEnv("MENTION_LOOKBACK_DAYS", 7),
    mentionSpikeMinCount: parseFloatEnv("MENTION_SPIKE_MIN_COUNT", 8),
    mentionSpikeRatio: parseFloatEnv("MENTION_SPIKE_RATIO", 4),
    mentionCooldownMinutes: parseFloatEnv("MENTION_COOLDOWN_MINUTES", 120),
    // 只盯这些 Yahoo symbol（逗号分隔，如 8035.T,6857.T,NVDA）；留空 = 全部
    mentionWatchlist: parseList(process.env.MENTION_WATCHLIST ?? ""),
    // 单票详细分析：>= 此值才逐个跑 Top 资产单票分析
    assetDetailMinAbsScore: parseFloatEnv("ASSET_DETAIL_MIN_ABS_SCORE", 0.65),
    // 单票详细分析数量
    assetDetailCount: parseIntEnv("ASSET_DETAIL_COUNT", 3),
  },
};

import dotenv from "dotenv";
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
    // 要监控的群友 username（不含@，支持多个）
    targetUsers: parseList(process.env.TG_TARGET_USERS ?? ""),
    // 你自己的 Telegram user ID（用于接收提醒）
    myUserId: parseIntEnv("TG_MY_USER_ID"),
    bombTarget: process.env.TG_BOMB_TARGET ?? "",
  },
  llm: {
    qianwenKey: process.env.QIANWEN_API_KEY ?? "",
    anthropicKey: process.env.ANTHROPIC_API_KEY ?? "",
  },
  keywords: {
    // 包含这些词就触发 AI 分析（不区分买卖，由 AI 判断）
    triggers: parseList(
      process.env.TRIGGER_KEYWORDS ??
        "大G,大g,梭哈,all.?in,全仓,割肉,跑路,爆仓,归零,上车,清仓",
    ),
  },
  sentiment: {
    // 情感分析触发条件：连续 N 条消息的平均分超过阈值
    batchSize: parseIntEnv("SENTIMENT_BATCH_SIZE", 20),
    windowSize: parseIntEnv("SENTIMENT_WINDOW_SIZE", 3),
    // 极端阈值：-1.0（极度悲观）~ 1.0（极度乐观），超过才触发
    extremeThreshold: parseFloatEnv("SENTIMENT_EXTREME_THRESHOLD", 0.75),
    // 两次提醒之间的最小间隔（分钟），避免刷屏
    cooldownMinutes: parseIntEnv("SENTIMENT_COOLDOWN_MINUTES", 30),
    // 简单分析：超过该情绪绝对值时，轻量总览会标记为简单分析
    simpleAnalysisMinAbsScore: parseFloatEnv("SIMPLE_ANALYSIS_MIN_ABS_SCORE", 0.6),
    // 重点监控：超过该情绪绝对值才做深度分析
    monitorMinAbsScore: parseFloatEnv("MONITOR_MIN_ABS_SCORE", 0.7),
    // 单票详细分析：只在群体情绪绝对值超过该阈值时触发
    assetDetailMinAbsScore: parseFloatEnv("ASSET_DETAIL_MIN_ABS_SCORE", 0.75),
    // 单票详细分析数量
    assetDetailCount: parseIntEnv("ASSET_DETAIL_COUNT", 3),
  },
};

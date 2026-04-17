import dotenv from "dotenv";
dotenv.config();

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required env variable: ${key}`);
  return value;
}

export const config = {
  telegram: {
    apiId: parseInt(requireEnv("TG_API_ID")),
    apiHash: requireEnv("TG_API_HASH"),
    // 要监控的群组 username 或 invite link（支持多个）
    targetGroups: requireEnv("TG_TARGET_GROUPS").split(",").map((s) => s.trim()),
    // 要监控的群友 username（不含@，支持多个）
    targetUsers: requireEnv("TG_TARGET_USERS").split(",").map((s) => s.trim()),
    // 你自己的 Telegram user ID（用于接收提醒）
    myUserId: parseInt(requireEnv("TG_MY_USER_ID")),
  },
  anthropic: {
    apiKey: requireEnv("ANTHROPIC_API_KEY"),
  },
  keywords: {
    // 包含这些词就触发 AI 分析（不区分买卖，由 AI 判断）
    triggers: (process.env.TRIGGER_KEYWORDS ?? "大G,大g,梭哈,all.?in,全仓,割肉,跑路,爆仓,归零,上车,清仓")
      .split(",")
      .map((k) => k.trim()),
  },
  sentiment: {
    // 情感分析触发条件：连续 N 条消息的平均分超过阈值
    batchSize: parseInt(process.env.SENTIMENT_BATCH_SIZE ?? "20"),
    windowSize: parseInt(process.env.SENTIMENT_WINDOW_SIZE ?? "3"),
    // 极端阈值：-1.0（极度悲观）~ 1.0（极度乐观），超过才触发
    extremeThreshold: parseFloat(process.env.SENTIMENT_EXTREME_THRESHOLD ?? "0.75"),
    // 两次提醒之间的最小间隔（分钟），避免刷屏
    cooldownMinutes: parseInt(process.env.SENTIMENT_COOLDOWN_MINUTES ?? "30"),
  },
};

import { analyzeDailySummary, DailySummaryResult } from "./analyzer";
import { config } from "./config";
import { buildBenchmarkMarketContext } from "./market-data";
import {
  createTelegramClient,
  fetchMessagesSince,
  formatJSTDateLabel,
  formatJSTTime,
  getSenderName,
  inJSTTradingHours,
  isOwnMessage,
  readSessionString,
  resolveGroup,
  sendToSavedMessages,
  todayJSTRange,
} from "./telegram-utils";

const START_MIN = 9 * 60;
const END_OF_DAY_MIN = 24 * 60;

function formatReport(
  result: DailySummaryResult,
  dateLabel: string,
  currentTime: string,
  messageCount: number,
  participantCount: number,
): string {
  const directionEmoji =
    result.score > 0.2 ? "📈" : result.score < -0.2 ? "📉" : "↔️";
  const topics = result.hotTopics.length
    ? result.hotTopics.map((topic) => `• ${topic}`).join("\n")
    : "暂无明确焦点";

  const lines: Array<string | null> = [
    `📋 今日综合总结 · ${dateLabel} · 09:00-${currentTime} JST`,
    `分析消息：${messageCount} 条 | 参与者：${participantCount} 人`,
    ``,
    `${directionEmoji} 群体方向：${result.label} (${(result.score * 100).toFixed(0)}%)`,
    `🔥 群体烈度：${(result.heat * 100).toFixed(0)}% | 来源：${result.heatDriver}`,
    result.dominantEmotion ? `🎭 主导情绪：${result.dominantEmotion}` : null,
    ``,
    `🗣️ 今日讨论`,
    result.discussionSummary,
    ``,
    `📊 大盘分析`,
    result.marketAnalysis,
    ``,
    `🔎 情绪与行情`,
    result.sentimentVsMarket,
    ``,
    `🏷️ 讨论焦点`,
    topics,
    ``,
    `⚠️ 风险观察`,
    result.riskWarning,
    ``,
    `📝 综合总结`,
    result.summary,
    ``,
    `仅供盘中观察，不构成投资建议。`,
  ];

  return lines.filter((line): line is string => line !== null).join("\n");
}

async function main(): Promise<void> {
  if (!readSessionString()) {
    console.error("❌ 未找到 session，请先运行: pnpm auth");
    process.exit(1);
  }

  const currentUnixSec = Math.floor(Date.now() / 1000);
  const currentTime = formatJSTTime(currentUnixSec);
  const [hour, minute] = currentTime.split(":").map(Number);
  if (hour * 60 + minute < START_MIN) {
    console.log("⏳ 当前尚未到 JST 09:00，暂无今日盘中消息可总结");
    return;
  }

  const client = createTelegramClient();
  await client.connect();

  const { start: dayStart } = todayJSTRange();
  const dateLabel = formatJSTDateLabel(dayStart);
  const marketContext = await buildBenchmarkMarketContext(
    config.report.benchmarks,
  );

  console.log(
    `✅ 已连接 | 今日总结：${dateLabel} 09:00-${currentTime} JST | 大盘：${config.report.benchmarks.join(", ")}`,
  );

  for (const group of config.telegram.targetGroups) {
    try {
      const entity = await resolveGroup(client, group);
      const allMessages = await fetchMessagesSince(client, entity, dayStart);
      const filtered = allMessages
        .filter(
          (message) =>
            message.date * 1000 >= dayStart &&
            message.text?.trim() &&
            inJSTTradingHours(message.date, START_MIN, END_OF_DAY_MIN) &&
            !(
              config.telegram.excludeSelf &&
              isOwnMessage(message, config.telegram.myUserId)
            ),
        )
        .reverse();

      if (filtered.length === 0) {
        console.log(`⚠️ ${group} 今天 JST 09:00 至当前暂无可分析消息`);
        continue;
      }

      const messages: { username: string; text: string }[] = [];
      for (const message of filtered) {
        messages.push({
          username: await getSenderName(message),
          text: message.text!.trim(),
        });
      }
      const participantCount = new Set(
        messages.map((message) => message.username),
      ).size;
      const statsContext = [
        `统计区间：JST 09:00-${currentTime}`,
        `消息数：${messages.length}`,
        `独立发言人数：${participantCount}`,
      ].join("；");

      console.log(`🤖 ${group} 正在生成今日综合总结...`);
      const result = await analyzeDailySummary(
        messages,
        marketContext,
        statsContext,
      );
      const report = formatReport(
        result,
        dateLabel,
        currentTime,
        messages.length,
        participantCount,
      );

      console.log("\n" + "─".repeat(50));
      console.log(report);
      console.log("─".repeat(50));
      await sendToSavedMessages(client, report);
      console.log(`✅ ${group} 的今日综合总结已发送到「已保存消息」`);
    } catch (error) {
      console.error(`${group} 今日总结失败:`, error);
    }
  }

  await client.disconnect();
}

main().catch((error) => {
  console.error("启动失败:", error);
  process.exit(1);
});

import { config } from "./config";
import { analyzePanicHype, PanicHypeResult } from "./analyzer";
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
  result: PanicHypeResult,
  msgCount: number,
  participantCount: number,
  dateLabel: string,
  currentTime: string,
): string {
  const bar = (v: number) => "█".repeat(Math.round(v / 10)) + "░".repeat(10 - Math.round(v / 10));
  const sideEmoji = result.dominantSide === "多" ? "📈" : result.dominantSide === "空" ? "📉" : "↔️";
  const stabilityEmoji = result.stabilityScore < 30 ? "🌋" : result.stabilityScore < 50 ? "⚠️" : result.stabilityScore < 70 ? "😬" : "🟢";

  const lines: string[] = [
    `👻 鬼叫指数日报 · ${dateLabel} · 09:00-${currentTime} JST`,
    `分析消息：${msgCount} 条 | 参与者：${participantCount} 人`,
    ``,
    `${stabilityEmoji} 市场稳定性  ${bar(result.stabilityScore)}  ${result.stabilityScore}/100（${result.stabilityLabel}）`,
    `😱 鬼叫指数    ${bar(result.panicIndex)}  ${result.panicIndex}/100`,
    `🔥 全群烈度    ${bar(result.heat)}  ${result.heat}/100（${result.heatDriver}）`,
    ``,
    `${sideEmoji} 主导方向：${result.dominantSide}方  |  做多 ${result.longBias}%  /  做空 ${result.shortBias}%`,
    `😱 鬼叫 ${result.panicCount} 人  |  💰 炫耀 ${result.hypeCount} 人`,
    ``,
    `📊 情绪演变`,
    result.phaseAnalysis,
    ``,
    `👥 群体行为`,
    result.crowdBehavior,
    ``,
    `📝 总结`,
    result.summary,
  ];

  lines.push(``, `⚡ 风险提示`, result.warning);
  lines.push(``, `🔮 行情推演`, result.marketOutlook);

  return lines.join("\n");
}

async function main() {
  if (!readSessionString()) {
    console.error("❌ 未找到 session，请先运行: pnpm auth");
    process.exit(1);
  }

  const currentUnixSec = Math.floor(Date.now() / 1000);
  const currentTime = formatJSTTime(currentUnixSec);
  const [hour, minute] = currentTime.split(":").map(Number);
  if (hour * 60 + minute < START_MIN) {
    console.log("⏳ 当前尚未到 JST 09:00，暂无今日消息可分析");
    return;
  }

  const { start: dayStart } = todayJSTRange();
  const dateLabel = formatJSTDateLabel(dayStart);
  const marketContext = await buildBenchmarkMarketContext(
    config.report.benchmarks,
  );

  const client = createTelegramClient();
  await client.connect();

  console.log(`✅ 已连接 | 分析区间：${dateLabel} 09:00-${currentTime} JST`);
  console.log(`   今日 JST 起点 UTC：${new Date(dayStart).toISOString()}`);

  for (const g of config.telegram.targetGroups) {
    try {
      const entity = await resolveGroup(client, g);
      console.log(`\n📡 分页拉取今日消息...`);

      const allMessages = await fetchMessagesSince(client, entity, dayStart);

      // 过滤：今日 JST 范围内 + 开盘时段
      const filtered = allMessages
        .filter((m) => {
          const ts = m.date * 1000;
          return (
            ts >= dayStart &&
            m.text?.trim() &&
            inJSTTradingHours(m.date, START_MIN, END_OF_DAY_MIN) &&
            !(
              config.telegram.excludeSelf &&
              isOwnMessage(m, config.telegram.myUserId)
            )
          );
        })
        .reverse();

      const todayTotal = allMessages.filter(m => m.date * 1000 >= dayStart && m.text?.trim()).length;
      console.log(`   拉取总计：${allMessages.length} 条 | 今日有文本：${todayTotal} 条 | 分析区间：${filtered.length} 条（09:00-${currentTime} JST）`);

      if (filtered.length === 0) {
        console.log(`   ⚠️ 暂无开盘期消息`);
        continue;
      }

      const buffer: { username: string; text: string }[] = [];
      for (const msg of filtered) {
        const name = await getSenderName(msg);
        buffer.push({ username: name, text: msg.text!.trim() });
      }

      console.log(`   🤖 AI 分析中...`);
      const participantCount = new Set(buffer.map((message) => message.username)).size;
      const statsContext = [
        `统计区间：JST 09:00-${currentTime}`,
        `消息数：${buffer.length}`,
        `独立发言人数：${participantCount}`,
      ].join("；");
      const result = await analyzePanicHype(buffer, marketContext, statsContext);
      const report = formatReport(
        result,
        buffer.length,
        participantCount,
        dateLabel,
        currentTime,
      );

      console.log("\n" + "─".repeat(50));
      console.log(report);
      console.log("─".repeat(50));

      await sendToSavedMessages(client, report);
      console.log(`\n✅ 报告已发送到「已保存消息」`);
    } catch (err) {
      console.error("分析失败:", err);
    }
  }

  await client.disconnect();
}

main().catch((err) => {
  console.error("启动失败:", err);
  process.exit(1);
});

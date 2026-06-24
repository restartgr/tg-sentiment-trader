import { config } from "./config";
import { analyzePanicHype, PanicHypeResult } from "./analyzer";
import {
  createTelegramClient,
  fetchMessagesSince,
  formatJSTDateLabel,
  getSenderName,
  inJSTTradingHours,
  readSessionString,
  resolveGroup,
  sendToSavedMessages,
  todayJSTRange,
} from "./telegram-utils";

function formatReport(result: PanicHypeResult, msgCount: number, dateLabel: string): string {
  const bar = (v: number) => "█".repeat(Math.round(v / 10)) + "░".repeat(10 - Math.round(v / 10));
  const sideEmoji = result.dominantSide === "多" ? "📈" : result.dominantSide === "空" ? "📉" : "↔️";
  const stabilityEmoji = result.stabilityScore < 30 ? "🌋" : result.stabilityScore < 50 ? "⚠️" : result.stabilityScore < 70 ? "😬" : "🟢";

  const lines: string[] = [
    `👻 鬼叫指数日报 · ${dateLabel} · 09:00-15:00 JST`,
    `分析消息：${msgCount} 条`,
    ``,
    `${stabilityEmoji} 市场稳定性  ${bar(result.stabilityScore)}  ${result.stabilityScore}/100（${result.stabilityLabel}）`,
    `😱 鬼叫指数    ${bar(result.panicIndex)}  ${result.panicIndex}/100`,
    ``,
    `${sideEmoji} 主导方向：${result.dominantSide}方  |  做多 ${result.longBias}%  /  做空 ${result.shortBias}%`,
    `😱 鬼叫 ${result.panicCount} 人  |  💰 炫耀 ${result.hypeCount} 人`,
    ``,
    `📊 盘中节奏`,
    result.phaseAnalysis,
    ``,
    `👥 群体行为`,
    result.crowdBehavior,
    ``,
    `📝 总结`,
    result.summary,
  ];

  lines.push(``, `⚡ 风险提示`, result.warning);
  lines.push(``, `🔄 逆向建议`, result.contrarian);

  return lines.join("\n");
}

async function main() {
  if (!readSessionString()) {
    console.error("❌ 未找到 session，请先运行: pnpm auth");
    process.exit(1);
  }

  const client = createTelegramClient();
  await client.connect();

  const { start: dayStart } = todayJSTRange();
  const dateLabel = formatJSTDateLabel(dayStart);

  console.log(`✅ 已连接 | 分析日期：${dateLabel}`);
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
          return ts >= dayStart && m.text?.trim() && inJSTTradingHours(m.date);
        })
        .reverse();

      const todayTotal = allMessages.filter(m => m.date * 1000 >= dayStart && m.text?.trim()).length;
      console.log(`   拉取总计：${allMessages.length} 条 | 今日有文本：${todayTotal} 条 | 交易时段：${filtered.length} 条（09:00-15:00 JST）`);

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
      const result = await analyzePanicHype(buffer);
      const report = formatReport(result, buffer.length, dateLabel);

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

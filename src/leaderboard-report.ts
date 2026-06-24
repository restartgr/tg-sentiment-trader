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

function formatLeaderboard(result: PanicHypeResult, dateLabel: string): string {
  if (result.leaderboard.length === 0) return `🏆 鬼叫排行榜 · ${dateLabel}\n（暂无上榜用户）`;

  const medals = ["🥇", "🥈", "🥉"];
  const lines: string[] = [
    `🏆 鬼叫排行榜 · ${dateLabel} · 10:00-15:30 JST`,
    ``,
  ];

  result.leaderboard.slice(0, 10).forEach((entry, i) => {
    const medal = medals[i] ?? `${i + 1}.`;
    const panicStr = entry.panicCount > 0 ? `叫${entry.panicCount}次` : "";
    const hypeStr  = entry.hypeCount  > 0 ? `炫${entry.hypeCount}次` : "";
    const counts   = [panicStr, hypeStr].filter(Boolean).join(" ");
    lines.push(`${medal} ${entry.username}【${entry.label}】${counts}  得分${entry.score}`);
    lines.push(`   "${entry.topQuote}"`);
  });

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

  console.log(`✅ 已连接 | 日期：${dateLabel}`);

  for (const g of config.telegram.targetGroups) {
    try {
      const entity = await resolveGroup(client, g);
      console.log(`\n📡 分页拉取今日消息...`);

      const allMessages = await fetchMessagesSince(client, entity, dayStart);

      const filtered = allMessages
        .filter((m) => {
          const ts = m.date * 1000;
          return ts >= dayStart && m.text?.trim() && inJSTTradingHours(m.date);
        })
        .reverse();

      console.log(`   开盘时段消息：${filtered.length} 条`);

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
      const report = formatLeaderboard(result, dateLabel);

      console.log("\n" + "─".repeat(50));
      console.log(report);
      console.log("─".repeat(50));

      await sendToSavedMessages(client, report);
      console.log(`\n✅ 排行榜已发送到「已保存消息」`);
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

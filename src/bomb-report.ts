import { config } from "./config";
import { analyzeBombUser, BombResult } from "./analyzer";
import {
  createTelegramClient,
  fetchMessagesSince,
  formatJSTDateLabel,
  formatJSTTime,
  readSessionString,
  resolveGroup,
  sendToSavedMessages,
  todayJSTStart,
} from "./telegram-utils";

const TARGET_USERNAME = config.telegram.bombTarget;

function formatReport(result: BombResult, msgCount: number, dateLabel: string): string {
  const bombBar = "█".repeat(Math.round(result.bombIndex / 10)) + "░".repeat(10 - Math.round(result.bombIndex / 10));
  const fearBar = "█".repeat(Math.round(result.fearIndex / 10)) + "░".repeat(10 - Math.round(result.fearIndex / 10));

  const lines: string[] = [
    `💣 炸弹指数日报 · @${TARGET_USERNAME} · ${dateLabel}`,
    `分析发言：${msgCount} 条`,
    ``,
    `🔥 亢奋指数  ${bombBar}  ${result.bombIndex}/100`,
    `😱 恐慌指数  ${fearBar}  ${result.fearIndex}/100`,
    ``,
    `${result.signalEmoji} 操作信号：【${result.signal}】`,
    ``,
    `💬 今日情绪`,
    result.mood,
    ``,
    `📝 分析`,
    result.summary,
    ``,
    `💡 操作建议`,
    result.action,
    ``,
    `🔄 逆向逻辑`,
    result.reasoning,
  ];

  if (result.keyMessages.length > 0) {
    lines.push(``, `📢 关键发言`);
    result.keyMessages.forEach((msg, i) => {
      lines.push(`${i + 1}. "${msg}"`);
    });
  }

  return lines.join("\n");
}

async function main() {
  if (!readSessionString()) {
    console.error("❌ 未找到 session，请先运行: pnpm auth");
    process.exit(1);
  }

  const client = createTelegramClient();
  await client.connect();

  const dayStart = todayJSTStart();
  const dateLabel = formatJSTDateLabel(dayStart.getTime());

  console.log(`✅ 已连接 | 追踪用户：@${TARGET_USERNAME} | 日期：${dateLabel}`);

  for (const g of config.telegram.targetGroups) {
    try {
      const entity = await resolveGroup(client, g);
      console.log(`\n📡 分页拉取消息...`);

      const allMessages = await fetchMessagesSince(
        client,
        entity,
        dayStart.getTime(),
      );

      // 筛选目标用户今日发言
      const userMessages: { text: string; time: string }[] = [];
      for (const msg of allMessages) {
        if (msg.date * 1000 < dayStart.getTime() || !msg.text?.trim()) continue;
        const sender = await msg.getSender();
        if (!sender) continue;
        const uname = "username" in sender ? sender.username : null;
        const fname = "firstName" in sender ? (sender as any).firstName : null;
        if (
          uname?.toLowerCase() === TARGET_USERNAME.toLowerCase() ||
          fname?.toLowerCase() === TARGET_USERNAME.toLowerCase()
        ) {
          const t = formatJSTTime(msg.date);
          userMessages.push({ text: msg.text.trim(), time: t });
        }
      }

      userMessages.reverse();
      console.log(`   @${TARGET_USERNAME} 今日发言：${userMessages.length} 条`);

      if (userMessages.length === 0) {
        console.log(`   ⚠️ 今日暂无该用户发言`);
        continue;
      }

      console.log(`   🤖 AI 分析中...`);
      const result = await analyzeBombUser(userMessages, TARGET_USERNAME);
      const report = formatReport(result, userMessages.length, dateLabel);

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

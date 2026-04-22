import { TelegramClient } from "telegram";
import { Api } from "telegram";
import { StringSession } from "telegram/sessions";
import fs from "fs";
import path from "path";
import { config } from "./config";
import { analyzeBombUser, BombResult } from "./analyzer";

const SESSION_FILE = path.join(process.cwd(), "session.txt");
const TARGET_USERNAME = config.telegram.bombTarget;

// 今日 JST 起点（JST 00:00 = 前一天 UTC 15:00）
function todayJSTStart(): Date {
  const now = new Date();
  const d = new Date(now);
  d.setUTCHours(15, 0, 0, 0);
  if (now.getUTCHours() < 15) d.setUTCDate(d.getUTCDate() - 1);
  return d;
}

async function resolveGroup(client: TelegramClient, g: string) {
  const inviteMatch = g.match(/(?:t\.me\/\+|t\.me\/joinchat\/)([A-Za-z0-9_-]+)/);
  if (inviteMatch) {
    const hash = inviteMatch[1];
    const result = await client.invoke(new Api.messages.CheckChatInvite({ hash }));
    if (result instanceof Api.ChatInviteAlready) return result.chat;
    if (result instanceof Api.ChatInvite) {
      const joined = await client.invoke(new Api.messages.ImportChatInvite({ hash }));
      if ("chats" in joined && joined.chats.length > 0) return joined.chats[0];
    }
  }
  const asNum = parseInt(g);
  if (!isNaN(asNum)) return client.getEntity(asNum);
  return client.getEntity(g);
}

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
  if (!fs.existsSync(SESSION_FILE) || !fs.readFileSync(SESSION_FILE, "utf-8").trim()) {
    console.error("❌ 未找到 session，请先运行: pnpm auth");
    process.exit(1);
  }

  const client = new TelegramClient(
    new StringSession(fs.readFileSync(SESSION_FILE, "utf-8").trim()),
    config.telegram.apiId,
    config.telegram.apiHash,
    { connectionRetries: 5 },
  );

  await client.connect();

  const dayStart = todayJSTStart();
  const dateLabel = new Date(dayStart.getTime() + 9 * 60 * 60 * 1000).toLocaleDateString("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit",
  });

  console.log(`✅ 已连接 | 追踪用户：@${TARGET_USERNAME} | 日期：${dateLabel}`);

  for (const g of config.telegram.targetGroups) {
    try {
      const entity = await resolveGroup(client, g);
      console.log(`\n📡 分页拉取消息...`);

      // 分页拉取今日全部消息
      const allMessages: Awaited<ReturnType<typeof client.getMessages>> = [];
      let offsetId = 0;
      while (true) {
        const batch = await client.getMessages(entity, { limit: 100, offsetId });
        if (batch.length === 0) break;
        allMessages.push(...batch);
        const oldest = batch[batch.length - 1];
        if (oldest.date * 1000 < dayStart.getTime()) break;
        offsetId = oldest.id;
      }

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
          const t = new Date(msg.date * 1000).toLocaleTimeString("zh-CN", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit" });
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

      await client.sendMessage("me", { message: report });
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

import { TelegramClient } from "telegram";
import { Api } from "telegram";
import { StringSession } from "telegram/sessions";
import fs from "fs";
import path from "path";
import { config } from "./config";
import { analyzePanicHype, PanicHypeResult } from "./analyzer";

const SESSION_FILE = path.join(process.cwd(), "session.txt");

const OPEN_UTC_MIN  = 1 * 60;
const CLOSE_UTC_MIN = 6 * 60 + 30;

function inTradingHours(unixSec: number): boolean {
  const d = new Date(unixSec * 1000);
  const min = d.getUTCHours() * 60 + d.getUTCMinutes();
  return min >= OPEN_UTC_MIN && min < CLOSE_UTC_MIN;
}

function todayUTCRange(): { start: number; end: number } {
  const now = new Date();
  const jstMidnight = new Date(now);
  jstMidnight.setUTCHours(15, 0, 0, 0);
  if (now.getUTCHours() < 15) {
    jstMidnight.setUTCDate(jstMidnight.getUTCDate() - 1);
  }
  return { start: jstMidnight.getTime(), end: jstMidnight.getTime() + 24 * 60 * 60 * 1000 };
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

  const { start: dayStart } = todayUTCRange();
  const dateLabel = new Date(dayStart + 9 * 60 * 60 * 1000).toLocaleDateString("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit",
  });

  console.log(`✅ 已连接 | 日期：${dateLabel}`);

  for (const g of config.telegram.targetGroups) {
    try {
      const entity = await resolveGroup(client, g);
      console.log(`\n📡 分页拉取今日消息...`);

      const allMessages: Awaited<ReturnType<typeof client.getMessages>> = [];
      let offsetId = 0;
      while (true) {
        const batch = await client.getMessages(entity, { limit: 100, offsetId });
        if (batch.length === 0) break;
        allMessages.push(...batch);
        const oldest = batch[batch.length - 1];
        if (oldest.date * 1000 < dayStart) break;
        offsetId = oldest.id;
      }

      const filtered = allMessages
        .filter((m) => {
          const ts = m.date * 1000;
          return ts >= dayStart && m.text?.trim() && inTradingHours(m.date);
        })
        .reverse();

      console.log(`   开盘时段消息：${filtered.length} 条`);

      if (filtered.length === 0) {
        console.log(`   ⚠️ 暂无开盘期消息`);
        continue;
      }

      const buffer: { username: string; text: string }[] = [];
      for (const msg of filtered) {
        const sender = await msg.getSender();
        const name =
          sender && "username" in sender
            ? (sender.username ?? ("firstName" in sender ? (sender as any).firstName : "匿名"))
            : "匿名";
        buffer.push({ username: name, text: msg.text!.trim() });
      }

      console.log(`   🤖 AI 分析中...`);
      const result = await analyzePanicHype(buffer);
      const report = formatLeaderboard(result, dateLabel);

      console.log("\n" + "─".repeat(50));
      console.log(report);
      console.log("─".repeat(50));

      await client.sendMessage("me", { message: report });
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

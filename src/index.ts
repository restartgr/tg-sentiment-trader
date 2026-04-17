import { TelegramClient } from "telegram";
import { Api } from "telegram";
import { StringSession } from "telegram/sessions";
import { NewMessage, NewMessageEvent } from "telegram/events";
import fs from "fs";
import path from "path";
import readline from "readline";
import { config } from "./config";
import { analyzeBatch } from "./analyzer";

const SESSION_FILE = path.join(process.cwd(), "session.txt");

interface BufferedMessage {
  username: string;
  text: string;
}

async function main() {
  if (
    !fs.existsSync(SESSION_FILE) ||
    !fs.readFileSync(SESSION_FILE, "utf-8").trim()
  ) {
    console.error("❌ 未找到 session，请先运行: pnpm auth");
    process.exit(1);
  }

  const sessionString = fs.readFileSync(SESSION_FILE, "utf-8").trim();
  const client = new TelegramClient(
    new StringSession(sessionString),
    config.telegram.apiId,
    config.telegram.apiHash,
    {
      connectionRetries: 5,
    },
  );

  await client.connect();
  console.log("✅ 已连接");

  async function resolveGroup(g: string) {
    const inviteMatch = g.match(
      /(?:t\.me\/\+|t\.me\/joinchat\/)([A-Za-z0-9_-]+)/,
    );
    if (inviteMatch) {
      const hash = inviteMatch[1];
      try {
        const result = await client.invoke(
          new Api.messages.CheckChatInvite({ hash }),
        );
        if (result instanceof Api.ChatInviteAlready) return result.chat;
        if (result instanceof Api.ChatInvite) {
          const joined = await client.invoke(
            new Api.messages.ImportChatInvite({ hash }),
          );
          if ("chats" in joined && joined.chats.length > 0)
            return joined.chats[0];
        }
      } catch (e: any) {
        if (e.errorMessage === "INVITE_REQUEST_SENT")
          throw new Error(`群组 ${g} 需要管理员审核`);
        throw e;
      }
    }
    const asNum = parseInt(g);
    if (!isNaN(asNum)) return client.getEntity(asNum);
    return client.getEntity(g);
  }

  const targetGroupEntities = await Promise.all(
    config.telegram.targetGroups.map(resolveGroup),
  );
  const normalizeId = (id: string) => id.replace(/^-100/, "");
  const targetGroupIds = new Set(
    targetGroupEntities.map((e: any) => normalizeId(e.id.toString())),
  );

  console.log(
    `📡 监控 ${config.telegram.targetGroups.length} 个群组，每 ${config.sentiment.batchSize} 条消息分析一次`,
  );

  const messageBuffers = new Map<string, BufferedMessage[]>();

  async function runBatchAnalysis(groupId: string, buffer: BufferedMessage[]) {
    try {
      const result = await analyzeBatch(buffer);
      const assetsShort =
        result.assets.map((a) => `${a.nickname}(${a.ticker})`).join(", ") ||
        "无";
      console.log(
        `📊 批量分析完成 | ${result.label}(${result.score.toFixed(2)}) | 资产: ${assetsShort} | ${result.summary}`,
      );

      if (Math.abs(result.score) < 0.3) return;

      const isBullish = result.score > 0;
      const emoji = isBullish ? "🚨📈" : "🚨📉";
      const sentiment = isBullish ? "群体极度乐观" : "群体极度悲观";

      let assetsStr = "";
      if (result.assets.length > 0) {
        const lines = result.assets.map((a) => {
          const ticker =
            a.ticker !== "未知"
              ? `${a.ticker} (${a.exchange})`
              : a.exchange || "未知市场";
          return `  • ${a.nickname} → ${a.name} | ${ticker}`;
        });
        assetsStr = `\n\n📌 涉及品种：\n${lines.join("\n")}`;
      }

      await client.sendMessage("me", {
        message: `${emoji} 群体情绪告警：${sentiment}\n\n📊 情感得分：${(result.score * 100).toFixed(0)}%\n💡 ${result.summary}${assetsStr}\n\n${result.signal}`,
      });
    } catch (err) {
      console.error("批量分析失败:", err);
    }
  }

  // 历史预热
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  console.log(`⏳ 拉取今日历史消息...`);

  for (const groupEntity of targetGroupEntities) {
    const groupId = normalizeId(groupEntity.id.toString());
    try {
      const allMessages = await client.getMessages(groupEntity, { limit: 200 });
      const todayMessages = allMessages
        .filter((m) => m.date * 1000 >= todayStart.getTime() && m.text?.trim())
        .reverse();

      console.log(`   今日消息 ${todayMessages.length} 条`);

      const buffer: BufferedMessage[] = [];
      for (const msg of todayMessages) {
        const sender = await msg.getSender();
        const name =
          sender && "username" in sender
            ? (sender.username ??
              ("firstName" in sender ? (sender as any).firstName : "匿名"))
            : "匿名";
        const text = msg.text!.trim();
        buffer.push({ username: name, text });
      }

      if (buffer.length >= config.sentiment.batchSize) {
        await runBatchAnalysis(groupId, buffer);
        messageBuffers.set(groupId, []);
      } else {
        messageBuffers.set(groupId, buffer);
        console.log(
          `   缓冲 ${buffer.length} 条，等待凑满 ${config.sentiment.batchSize} 条`,
        );
      }
    } catch (err) {
      console.error("   ⚠️ 拉取历史失败:", err);
      messageBuffers.set(groupId, []);
    }
  }

  console.log("✅ 预热完成，开始监听实时消息\n");

  client.addEventHandler(
    async (event: NewMessageEvent) => {
      const message = event.message;
      if (!message.text) return;

      const chatId = message.chatId?.toString();
      if (!chatId || !targetGroupIds.has(normalizeId(chatId))) return;

      const sender = await message.getSender();
      if (!sender) return;

      const name =
        "username" in sender
          ? (sender.username ??
            ("firstName" in sender ? (sender as any).firstName : "匿名"))
          : "匿名";

      const text = message.text.trim();
      const groupId = normalizeId(chatId);

      if (!messageBuffers.has(groupId)) messageBuffers.set(groupId, []);
      const buffer = messageBuffers.get(groupId)!;
      buffer.push({ username: name, text });
      console.log(
        `📨 [${name}] ${text.slice(0, 50)}${text.length > 50 ? "..." : ""} (${buffer.length}/${config.sentiment.batchSize})`,
      );

      if (buffer.length >= config.sentiment.batchSize) {
        const batch = buffer.splice(0);
        await runBatchAnalysis(groupId, batch);
      }
    },
    new NewMessage({ incoming: true, outgoing: true }),
  );

  console.log("🤖 机器人运行中，按 Ctrl+C 退出...");
  console.log("💬 直接输入消息回车发送到群组\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on("line", async (line) => {
    const text = line.trim();
    if (!text) return;
    for (const entity of targetGroupEntities) {
      try {
        await client.sendMessage(entity as any, { message: text });
        console.log("✅ 已发送");
      } catch (err) {
        console.error("❌ 发送失败:", err);
      }
    }
  });

  await new Promise(() => {});
}

main().catch((err) => {
  console.error("启动失败:", err);
  process.exit(1);
});

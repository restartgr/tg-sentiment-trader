import { TelegramClient } from "telegram";
import { NewMessage, NewMessageEvent } from "telegram/events";
import { config } from "./config";
import {
  analyzeAssetDetail,
  analyzeBatch,
  analyzeBatchScore,
  AssetDetailAnalysis,
  BatchScoreResult,
} from "./analyzer";
import {
  createTelegramClient,
  getSenderName,
  normalizeTelegramId,
  readSessionString,
  resolveGroup,
  sendToSavedMessages,
  todayJSTStart,
} from "./telegram-utils";

interface BufferedMessage {
  username: string;
  text: string;
}

function tidyBlock(text: string): string {
  return text
    .replace(/；/g, "；\n")
    .replace(/。/g, "。\n")
    .replace(/：(?=①|②|③|④|⑤)/g, "：\n")
    .replace(/(?=①|②|③|④|⑤)/g, "\n")
    .replace(/\s*\/\s*/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function formatSection(title: string, text: string): string {
  if (!text.trim()) return "";
  return `${title}\n${tidyBlock(text)}`;
}

function formatAssetDetail(detail: AssetDetailAnalysis): string {
  return [
    `📌 单票分析：${detail.title}`,
    ``,
    formatSection("🎭 情绪", detail.mood),
    formatSection("📰 新闻", detail.news),
    formatSection("📐 技术", detail.technical),
    formatSection("🧭 情绪信号", detail.emotionSignal),
    formatSection("🎯 操作评价", detail.tradeView),
    formatSection("📍 关键点位", detail.levels),
    formatSection("⚠️ 风险", detail.risk),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function formatQuickScore(result: BatchScoreResult): string {
  const emoji = result.score > 0 ? "📈" : result.score < 0 ? "📉" : "➖";
  const absScore = Math.abs(result.score);
  const title =
    absScore >= config.sentiment.simpleAnalysisMinAbsScore
      ? "情绪总览（简单分析）"
      : "情绪总览";
  const note =
    absScore >= config.sentiment.simpleAnalysisMinAbsScore
      ? "情绪有一定方向，但未进入重点监控区。"
      : "日常波动，暂不深入分析。";

  return [
    `${emoji} ${title}：${result.label} (${(result.score * 100).toFixed(0)}%)`,
    result.dominantEmotion ? `🎭 ${result.dominantEmotion}` : "",
    `💬 ${result.comment}`,
    `🧭 ${note}`,
  ]
    .filter(Boolean)
    .join("\n");
}

async function main() {
  if (!readSessionString()) {
    console.error("❌ 未找到 session，请先运行: pnpm auth");
    process.exit(1);
  }

  const client: TelegramClient = createTelegramClient();

  await client.connect();
  console.log("✅ 已连接");

  const targetGroupEntities = await Promise.all(
    config.telegram.targetGroups.map((group) => resolveGroup(client, group)),
  );
  const targetGroupIds = new Set(
    targetGroupEntities.map((e: any) => normalizeTelegramId(e.id.toString())),
  );

  console.log(
    `📡 监控 ${config.telegram.targetGroups.length} 个群组，每 ${config.sentiment.batchSize} 条消息分析一次`,
  );

  const messageBuffers = new Map<string, BufferedMessage[]>();

  async function runBatchAnalysis(groupId: string, buffer: BufferedMessage[]) {
    try {
      const quick = await analyzeBatchScore(buffer);
      const quickAbsScore = Math.abs(quick.score);

      if (quickAbsScore < config.sentiment.monitorMinAbsScore) {
        console.log(
          `📎 轻量总览完成 | ${quick.label}(${quick.score.toFixed(2)}) | ${quick.comment}`,
        );
        await sendToSavedMessages(client, formatQuickScore(quick));
        return;
      }

      const result = await analyzeBatch(buffer);
      const assetsShort =
        result.topAssets.map((a) => `${a.nickname}(${a.ticker})`).join(", ") ||
        "无";
      console.log(
        `📊 批量分析完成 | ${result.label}(${result.score.toFixed(2)}) | ${result.dominantEmotion} | Top: ${assetsShort} | ${result.summary}`,
      );

      const absScore = Math.abs(result.score);
      const isBullish = result.score > 0;
      const emoji = isBullish ? "🚨📈" : "🚨📉";
      const monitorLine =
        absScore >= config.sentiment.assetDetailMinAbsScore
          ? "🔥 主要监控：情绪已进入单票分析区，可结合点位考虑买卖"
          : absScore >= config.sentiment.monitorMinAbsScore
            ? "👀 进入监控区：情绪开始有交易价值，先观察点位和后续发酵"
            : "";

      let assetsStr = "";
      if (result.topAssets.length > 0) {
        const lines = result.topAssets.map((a) => {
          const ticker =
            a.ticker !== "未知"
              ? `${a.ticker} (${a.exchange})`
              : a.exchange || "未知市场";
          return `  • ${a.nickname} → ${a.name} | ${ticker}`;
        });
        assetsStr = `\n\n📌 热议Top${result.topAssets.length}：\n${lines.join("\n")}`;
      }

      const topicsStr = result.hotTopics.length
        ? `\n\n🔥 讨论焦点：${result.hotTopics.join("、")}`
        : "";

      const msg = [
        `${emoji} 群体情绪告警：${result.label}`,
        ``,
        `📊 情感得分：${(result.score * 100).toFixed(0)}%`,
        `🎭 主导情绪：${result.dominantEmotion}`,
        monitorLine,
        ``,
        `💭 情绪剖析：`,
        result.emotionDetail,
        ``,
        `⚖️ 分歧状态：${result.divergence}`,
        `👥 群体行为：${result.crowdBehavior}`,
        result.riskWarning ? `\n⚠️ 风险提示：${result.riskWarning}` : "",
        `${topicsStr}${assetsStr}`,
        ``,
        `💡 总结：${result.summary}`,
        `🎯 ${result.signal}`,
      ]
        .filter((l) => l !== "")
        .join("\n");

      await sendToSavedMessages(client, msg);

      if (absScore < config.sentiment.assetDetailMinAbsScore) {
        console.log(
          `⏭️ 情绪未达到单票分析阈值 ${config.sentiment.assetDetailMinAbsScore}，仅发送总览`,
        );
        return;
      }

      for (const asset of result.topAssets.slice(0, config.sentiment.assetDetailCount)) {
        const detail = await analyzeAssetDetail(asset, result, buffer);
        await sendToSavedMessages(client, formatAssetDetail(detail));
      }
    } catch (err) {
      console.error("批量分析失败:", err);
    }
  }

  // 历史预热
  const todayStart = todayJSTStart();
  console.log(`⏳ 拉取今日历史消息...`);

  for (const groupEntity of targetGroupEntities) {
    const groupId = normalizeTelegramId(groupEntity.id.toString());
    try {
      const allMessages = await client.getMessages(groupEntity, { limit: 200 });
      const todayMessages = allMessages
        .filter((m) => m.date * 1000 >= todayStart.getTime() && m.text?.trim())
        .reverse();

      console.log(`   今日消息 ${todayMessages.length} 条`);

      const buffer: BufferedMessage[] = [];
      for (const msg of todayMessages) {
        const name = await getSenderName(msg);
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
      if (!chatId || !targetGroupIds.has(normalizeTelegramId(chatId))) return;

      const name = await getSenderName(message);
      const text = message.text.trim();
      const groupId = normalizeTelegramId(chatId);

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
    new NewMessage({ incoming: true }),
  );

  console.log("🤖 机器人运行中（只读监控），按 Ctrl+C 退出...\n");

  await new Promise(() => {});
}

main().catch((err) => {
  console.error("启动失败:", err);
  process.exit(1);
});

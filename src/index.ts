import { Api, TelegramClient } from "telegram";
import { NewMessage, NewMessageEvent } from "telegram/events";
import { config } from "./config";
import {
  hasCompletedAnalysis,
  initDatabase,
  saveBatch,
  saveMessage,
} from "./db";
import {
  analyzeAssetDetail,
  analyzeBatch,
  analyzeBatchScore,
  AssetDetailAnalysis,
  BatchAnalysisResult,
  BatchScoreResult,
  buildBatchMarketContext,
  NO_MARKET_CONTEXT,
} from "./analyzer";
import {
  createTelegramClient,
  fetchMessagesSince,
  getSenderName,
  isOwnMessage,
  normalizeTelegramId,
  readSessionString,
  resolveGroup,
  sendToSavedMessages,
  todayJSTStart,
} from "./telegram-utils";

interface BufferedMessage {
  dbId: number;
  username: string;
  text: string;
  messageTs: number;
}

type AnalysisTier = "simple" | "monitor" | "detail";

interface TierRule {
  tier: AnalysisTier;
  minAbsScore: number; // 轻量评分绝对值达到此值即命中该档
  includeMarket: boolean; // 是否调取实时行情上下文
  runAssetDetail: boolean; // 是否逐个跑 Top 资产单票分析
  banner: string; // 告警消息里的档位提示行
}

// 从高到低排列，命中第一个达标的档位；都不达标 → 只发轻量总览。
// 轻量评分决定是否进入复核；深度分析后会按最终分数确认或降级档位。
const ANALYSIS_TIERS: TierRule[] = [
  {
    tier: "detail",
    minAbsScore: config.sentiment.assetDetailMinAbsScore,
    includeMarket: true,
    runAssetDetail: true,
    banner: "🔥 主要监控：情绪已进入单票分析区，可结合点位考虑买卖",
  },
  {
    tier: "monitor",
    minAbsScore: config.sentiment.monitorMinAbsScore,
    includeMarket: true,
    runAssetDetail: false,
    banner: "👀 进入监控区：情绪开始有交易价值，先观察点位和后续发酵",
  },
  {
    tier: "simple",
    minAbsScore: config.sentiment.simpleAnalysisMinAbsScore,
    includeMarket: false,
    runAssetDetail: false,
    banner: "🔍 简单分析区：情绪有方向但未进监控区，本档未结合实时行情，仅供参考",
  },
];

function resolveTier(absScore: number): TierRule | null {
  return ANALYSIS_TIERS.find((rule) => absScore >= rule.minAbsScore) ?? null;
}

function tierRank(rule: TierRule): number {
  return ANALYSIS_TIERS.length - ANALYSIS_TIERS.indexOf(rule);
}

function resolveEffectiveTier(initialRule: TierRule, finalScore: number): TierRule | null {
  const finalRule = resolveTier(Math.abs(finalScore));
  if (!finalRule) return null;
  return tierRank(finalRule) <= tierRank(initialRule) ? finalRule : initialRule;
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

  return [
    `${emoji} 情绪总览：${result.label} (${(result.score * 100).toFixed(0)}%)`,
    result.dominantEmotion ? `🎭 ${result.dominantEmotion}` : "",
    `💬 ${result.comment}`,
    `🧭 日常波动，暂不深入分析。`,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatPreheatSummary(
  result: BatchScoreResult,
  messageCount: number,
): string {
  const emoji = result.score > 0 ? "📈" : result.score < 0 ? "📉" : "➖";

  return [
    `📋 今日预热总结（${messageCount} 条消息）`,
    `${emoji} 整体情绪：${result.label} (${(result.score * 100).toFixed(0)}%)`,
    result.dominantEmotion ? `🎭 主导情绪：${result.dominantEmotion}` : "",
    `💬 ${result.comment}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatDowngradedAnalysis(
  result: BatchAnalysisResult,
  initialRule: TierRule,
): string {
  const emoji = result.score > 0 ? "📈" : result.score < 0 ? "📉" : "➖";

  return [
    `${emoji} 情绪总览：${result.label} (${(result.score * 100).toFixed(0)}%)`,
    result.dominantEmotion ? `🎭 ${result.dominantEmotion}` : "",
    `💬 ${result.summary}`,
    `🧭 轻量评分触发 ${initialRule.tier} 复核，但深度复核未达监控阈值，暂不进入监控区。`,
  ]
    .filter(Boolean)
    .join("\n");
}

async function persistTelegramMessage(
  message: Api.Message,
  groupId: string,
): Promise<BufferedMessage> {
  const username = await getSenderName(message);
  const text = message.text!.trim();
  const dbId = saveMessage({
    tgMessageId: message.id,
    groupId,
    senderId: message.senderId?.toString() ?? null,
    username,
    text,
    messageTs: message.date * 1000,
  });

  return {
    dbId,
    username,
    text,
    messageTs: message.date * 1000,
  };
}

function getBatchTimeRange(buffer: BufferedMessage[]): {
  startTime: number;
  endTime: number;
} {
  return buffer.reduce(
    (range, message) => ({
      startTime: Math.min(range.startTime, message.messageTs),
      endTime: Math.max(range.endTime, message.messageTs),
    }),
    { startTime: buffer[0].messageTs, endTime: buffer[0].messageTs },
  );
}

async function main() {
  if (!readSessionString()) {
    console.error("❌ 未找到 session，请先运行: pnpm auth");
    process.exit(1);
  }

  initDatabase();
  console.log("🗄️ SQLite 数据库已就绪");

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

  async function runPreheatSummary(
    groupId: string,
    buffer: BufferedMessage[],
  ): Promise<void> {
    const { startTime, endTime } = getBatchTimeRange(buffer);
    const messageIds = buffer.map((message) => message.dbId);

    try {
      // 预热只调用一次轻量总结，不进入实时档位、行情或单票分析流程。
      const summary = await analyzeBatchScore(buffer);
      saveBatch({
        groupId,
        messageIds,
        startTime,
        endTime,
        quickScore: summary.score,
        finalScore: null,
        initialTier: "preheat",
        finalTier: "preheat",
        dominantEmotion: summary.dominantEmotion,
        summary: summary.comment,
        marketInsight: "",
        result: { preheat: summary },
        status: "completed",
      });

      await sendToSavedMessages(
        client,
        formatPreheatSummary(summary, buffer.length),
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      try {
        saveBatch({
          groupId,
          messageIds,
          startTime,
          endTime,
          quickScore: null,
          finalScore: null,
          initialTier: "preheat",
          finalTier: null,
          dominantEmotion: "",
          summary: "",
          marketInsight: "",
          result: {},
          status: "failed",
          errorMessage: reason,
        });
      } catch (dbErr) {
        console.error("预热失败记录写入数据库失败:", dbErr);
      }
      console.error("预热总结失败:", err);
    }
  }

  async function runBatchAnalysis(groupId: string, buffer: BufferedMessage[]) {
    const { startTime, endTime } = getBatchTimeRange(buffer);
    const messageIds = buffer.map((message) => message.dbId);
    let quickResult: BatchScoreResult | null = null;
    let initialTier: AnalysisTier | null = null;
    let persistedBatchId: number | null = null;

    try {
      const quick = await analyzeBatchScore(buffer);
      quickResult = quick;
      const quickAbsScore = Math.abs(quick.score);

      const rule = resolveTier(quickAbsScore);
      initialTier = rule?.tier ?? null;

      // 未达最低档（默认 < 0.5）：只发轻量总览
      if (!rule) {
        persistedBatchId = saveBatch({
          groupId,
          messageIds,
          startTime,
          endTime,
          quickScore: quick.score,
          finalScore: null,
          initialTier: null,
          finalTier: "quick",
          dominantEmotion: quick.dominantEmotion,
          summary: quick.comment,
          marketInsight: "",
          result: { quick },
          status: "completed",
        });
        console.log(
          `📎 轻量总览完成 | ${quick.label}(${quick.score.toFixed(2)}) | ${quick.comment}`,
        );
        await sendToSavedMessages(client, formatQuickScore(quick));
        return;
      }

      // 行情上下文由调用方按档位准备好再注入，analyzeBatch 不关心是否拉取。
      const marketContext = rule.includeMarket
        ? await buildBatchMarketContext(buffer)
        : NO_MARKET_CONTEXT;
      const result = await analyzeBatch(buffer, marketContext);
      const effectiveRule = resolveEffectiveTier(rule, result.score);
      persistedBatchId = saveBatch({
        groupId,
        messageIds,
        startTime,
        endTime,
        quickScore: quick.score,
        finalScore: result.score,
        initialTier: rule.tier,
        finalTier: effectiveRule?.tier ?? "quick",
        dominantEmotion: result.dominantEmotion,
        summary: result.summary,
        marketInsight: result.marketInsight,
        result: { quick, analysis: result },
        status: "completed",
      });
      const assetsShort =
        result.topAssets.map((a) => `${a.nickname}(${a.ticker})`).join(", ") ||
        "无";
      console.log(
        `📊 ${rule.tier} 分析完成 | 复核档位:${effectiveRule?.tier ?? "quick"} | ${result.label}(${result.score.toFixed(2)}) | ${result.dominantEmotion} | 行情:${rule.includeMarket ? "是" : "否"} | Top: ${assetsShort} | ${result.summary}`,
      );

      if (!effectiveRule) {
        await sendToSavedMessages(client, formatDowngradedAnalysis(result, rule));
        return;
      }

      const emoji = result.score > 0 ? "🚨📈" : "🚨📉";

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

      const marketInsightStr =
        effectiveRule.includeMarket && result.marketInsight
          ? `\n\n📈 行情视角：${result.marketInsight}`
          : "";

      const msg = [
        `${emoji} 群体情绪告警：${result.label}`,
        ``,
        `📊 情感得分：${(result.score * 100).toFixed(0)}%`,
        `🎭 主导情绪：${result.dominantEmotion}`,
        effectiveRule.banner,
        ``,
        `💭 情绪剖析：`,
        result.emotionDetail,
        ``,
        `⚖️ 分歧状态：${result.divergence}`,
        `👥 群体行为：${result.crowdBehavior}`,
        result.riskWarning ? `\n⚠️ 风险提示：${result.riskWarning}` : "",
        `${topicsStr}${assetsStr}${marketInsightStr}`,
        ``,
        `💡 总结：${result.summary}`,
        `🎯 ${result.signal}`,
      ]
        .filter((l) => l !== "")
        .join("\n");

      await sendToSavedMessages(client, msg);

      if (!effectiveRule.runAssetDetail) {
        console.log(`⏭️ 当前档位 ${effectiveRule.tier}，仅发送总览`);
        return;
      }

      for (const asset of result.topAssets.slice(0, config.sentiment.assetDetailCount)) {
        const detail = await analyzeAssetDetail(asset, result, buffer);
        await sendToSavedMessages(client, formatAssetDetail(detail));
      }
    } catch (err) {
      if (persistedBatchId === null) {
        try {
          saveBatch({
            groupId,
            messageIds,
            startTime,
            endTime,
            quickScore: quickResult?.score ?? null,
            finalScore: null,
            initialTier,
            finalTier: null,
            dominantEmotion: quickResult?.dominantEmotion ?? "",
            summary: quickResult?.comment ?? "",
            marketInsight: "",
            result: { quick: quickResult },
            status: "failed",
            errorMessage: err instanceof Error ? err.message : String(err),
          });
        } catch (dbErr) {
          console.error("失败记录写入数据库失败:", dbErr);
        }
      }

      // 不把解析失败当成中性数据：明确报错，不产生假的情绪读数。
      console.error("批量分析失败:", err);
      const reason = err instanceof Error ? err.message : String(err);
      try {
        await sendToSavedMessages(
          client,
          `⚠️ 本批情绪分析失败，已跳过（不计入情绪读数）。\n原因：${reason}`,
        );
      } catch (sendErr) {
        console.error("分析失败通知发送失败:", sendErr);
      }
    }
  }

  // 历史预热
  const todayStart = todayJSTStart();
  console.log(`⏳ 拉取今日历史消息...`);

  for (const groupEntity of targetGroupEntities) {
    const groupId = normalizeTelegramId(groupEntity.id.toString());
    try {
      const allMessages = await fetchMessagesSince(
        client,
        groupEntity,
        todayStart.getTime(),
      );
      const todayMessages = allMessages
        .filter(
          (m) =>
            m.date * 1000 >= todayStart.getTime() &&
            m.text?.trim() &&
            !(
              config.telegram.excludeSelf &&
              isOwnMessage(m, config.telegram.myUserId)
            ),
        )
        .reverse();

      console.log(`   今日消息 ${todayMessages.length} 条`);

      const buffer: BufferedMessage[] = [];
      for (const msg of todayMessages) {
        const storedMessage = await persistTelegramMessage(msg, groupId);
        buffer.push(storedMessage);
      }

      // 启动预热只看一次全天总结；实时监听才按 batchSize 进入完整 workflow。
      if (buffer.length > 0) {
        await runPreheatSummary(groupId, buffer);
        messageBuffers.set(groupId, []);
      } else {
        messageBuffers.set(groupId, buffer);
        console.log("   今日没有待分析消息");
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

      // 剔除自己的发言，避免自我干扰情绪分析。
      if (config.telegram.excludeSelf && isOwnMessage(message, config.telegram.myUserId))
        return;

      const chatId = message.chatId?.toString();
      if (!chatId || !targetGroupIds.has(normalizeTelegramId(chatId))) return;

      const groupId = normalizeTelegramId(chatId);
      const storedMessage = await persistTelegramMessage(message, groupId);

      if (!messageBuffers.has(groupId)) messageBuffers.set(groupId, []);
      const buffer = messageBuffers.get(groupId)!;
      if (
        hasCompletedAnalysis(storedMessage.dbId) ||
        buffer.some((item) => item.dbId === storedMessage.dbId)
      ) {
        return;
      }

      buffer.push(storedMessage);
      console.log(
        `📨 [${storedMessage.username}] ${storedMessage.text.slice(0, 50)}${storedMessage.text.length > 50 ? "..." : ""} (${buffer.length}/${config.sentiment.batchSize})`,
      );

      if (buffer.length >= config.sentiment.batchSize) {
        const batch = buffer.splice(0);
        await runBatchAnalysis(groupId, batch);
      }
    },
    new NewMessage({ incoming: true, outgoing: true }),
  );

  console.log("🤖 机器人运行中（只读监控），按 Ctrl+C 退出...\n");

  await new Promise(() => {});
}

main().catch((err) => {
  console.error("启动失败:", err);
  process.exit(1);
});

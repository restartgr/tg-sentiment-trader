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
  getSenderName,
  isOwnMessage,
  normalizeTelegramId,
  readSessionString,
  resolveGroup,
  sendToSavedMessages,
} from "./telegram-utils";
import {
  decideDeepOutcome,
  heatDriverEmoji,
  heatDriverHeadline,
  isHeatTriggered,
  isScoreTriggered,
  marketAllowedThisRound,
  shouldDeepAnalyze,
  triggerReason,
} from "./routing";

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

// 交易档位只由方向轴 score 决定（不由 heat 决定）。深度轮复核后取较保守的一档：
// 若初筛已给出方向档，最终不超过它；初筛无方向档时直接采用深度轮的方向档。
function resolveEffectiveDirectionTier(
  initialRule: TierRule | null,
  finalScore: number,
): TierRule | null {
  const finalRule = resolveTier(Math.abs(finalScore));
  if (!finalRule) return null;
  if (!initialRule) return finalRule;
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

// 烈度展示：始终显示，方便实时观察与校准。
function formatHeatLine(heat: number): string {
  const level =
    heat >= 0.85
      ? "全群炸锅"
      : heat >= 0.6
        ? "情绪激烈"
        : heat >= 0.3
          ? "有情绪"
          : "平淡";
  return `🔥 烈度：${(heat * 100).toFixed(0)}%（${level}）`;
}


function formatQuickScore(result: BatchScoreResult): string {
  const emoji = result.score > 0 ? "📈" : result.score < 0 ? "📉" : "➖";

  return [
    `${emoji} 情绪总览：${result.label} (${(result.score * 100).toFixed(0)}%)`,
    formatHeatLine(result.heat),
    result.dominantEmotion ? `🎭 ${result.dominantEmotion}` : "",
    `💬 ${result.comment}`,
    `🧭 日常波动，暂不深入分析。`,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatDowngradedAnalysis(result: BatchAnalysisResult): string {
  const emoji = result.score > 0 ? "📈" : result.score < 0 ? "📉" : "➖";

  return [
    `${emoji} 情绪总览：${result.label} (${(result.score * 100).toFixed(0)}%)`,
    result.dominantEmotion ? `🎭 ${result.dominantEmotion}` : "",
    `💬 ${result.summary}`,
    `🧭 触发了深度复核，但方向未达监控阈值、烈度也已回落，暂不进入监控区。`,
  ]
    .filter(Boolean)
    .join("\n");
}

// 纯烈度过热告警（第一阶段：heat 触发路径一律未拉行情）：
// 只描述情绪状态与来源，不展示行情/资产/单票，不给买卖或反向。
function formatOverheatAlert(result: BatchAnalysisResult): string {
  const driver = result.heatDriver;
  const topicsStr = result.hotTopics.length
    ? `\n\n🔥 讨论焦点：${result.hotTopics.join("、")}`
    : "";

  return [
    `${heatDriverEmoji(driver)} 群体情绪过热：${heatDriverHeadline(driver)}`,
    ``,
    formatHeatLine(result.heat),
    `🧭 烈度来源：${driver}`,
    result.dominantEmotion ? `🎭 主导情绪：${result.dominantEmotion}` : "",
    ``,
    `💭 情绪剖析：`,
    result.emotionDetail,
    ``,
    `⚖️ 分歧状态：${result.divergence}`,
    `👥 群体行为：${result.crowdBehavior}`,
    result.riskWarning ? `\n⚠️ 风险提示：${result.riskWarning}` : "",
    topicsStr,
    ``,
    `💡 总结：${result.summary}`,
    `🧭 本轮未加载行情，仅为情绪过热观察，非交易信号，不含买卖/反向/点位建议。`,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

// 纯 heat 触发但深度复核把 score 抬到方向档：本轮未拉行情，不输出交易内容。
function formatDirectionUpgradedNoMarket(result: BatchAnalysisResult): string {
  const emoji = result.score > 0 ? "📈" : result.score < 0 ? "📉" : "➖";

  return [
    `${emoji} 深度复核发现方向变化：${result.label} (${(result.score * 100).toFixed(0)}%)`,
    formatHeatLine(result.heat),
    result.dominantEmotion ? `🎭 主导情绪：${result.dominantEmotion}` : "",
    ``,
    `💭 情绪剖析：`,
    result.emotionDetail,
    ``,
    `💡 总结：${result.summary}`,
    `🧭 本轮因烈度触发、未加载行情，方向仅供参考；不给行情观点、交易 Banner、单票或点位建议，等待下一轮带行情复核。`,
  ]
    .filter((l) => l !== "")
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

// 群聊节奏：发言密度（条/分钟）作为烈度的客观依据喂给模型。
function describePace(buffer: BufferedMessage[]): string {
  const { startTime, endTime } = getBatchTimeRange(buffer);
  const spanMin = Math.max((endTime - startTime) / 60000, 0.1);
  const perMin = buffer.length / spanMin;
  return `【群聊节奏】${buffer.length} 条消息集中在约 ${spanMin.toFixed(1)} 分钟内（约 ${perMin.toFixed(1)} 条/分钟）。密度只代表活跃度，是否激烈要结合措辞判断：冷静的高频讨论不等于高烈度。`;
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

  async function runBatchAnalysis(groupId: string, buffer: BufferedMessage[]) {
    const { startTime, endTime } = getBatchTimeRange(buffer);
    const messageIds = buffer.map((message) => message.dbId);
    let quickResult: BatchScoreResult | null = null;
    let initialTier: AnalysisTier | null = null;
    let persistedBatchId: number | null = null;

    const paceNote = describePace(buffer);

    try {
      const quick = await analyzeBatchScore(buffer, paceNote);
      quickResult = quick;

      // 双触发：score 或 heat 任一达标都进 Deep（两个阈值相互独立）。
      const scoreTriggered = isScoreTriggered(
        quick.score,
        config.sentiment.simpleAnalysisMinAbsScore,
      );
      const heatTriggered = isHeatTriggered(
        quick.heat,
        config.sentiment.heatDeepThreshold,
      );
      const wantDeep = shouldDeepAnalyze(
        quick.score,
        quick.heat,
        config.sentiment.simpleAnalysisMinAbsScore,
        config.sentiment.heatDeepThreshold,
      );
      const reason = triggerReason(scoreTriggered, heatTriggered);
      // 交易档位只看方向轴 score（heat 不参与）。
      const quickDirectionRule = resolveTier(Math.abs(quick.score));
      initialTier = quickDirectionRule?.tier ?? null;

      // 结构化日志基础字段（timestamp 在 emit 时统一补）。
      const logBase = {
        event: "sentiment_analysis",
        quickScore: quick.score,
        quickHeat: quick.heat,
        quickHeatDriver: quick.heatDriver,
        scoreTriggered,
        heatTriggered,
        triggerReason: reason,
        modelLight: config.llm.modelLight,
        modelDeep: config.llm.modelDeep,
      };
      const emitLog = (extra: Record<string, unknown>) => {
        console.log(
          JSON.stringify({
            ...logBase,
            ...extra,
            batchId: persistedBatchId,
            timestamp: new Date().toISOString(),
          }),
        );
      };

      // 强度未达最低档：只发轻量总览。
      if (!wantDeep) {
        const log = {
          ...logBase,
          finalScore: null,
          finalHeat: null,
          finalHeatDriver: "",
          marketContextLoaded: false,
          deepDirectionUpgraded: false,
          alertPushed: true,
          initialTier: "",
          finalTier: "quick",
        };
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
          result: { quick, log },
          status: "completed",
        });
        emitLog(log);
        console.log(
          `📎 轻量总览 | ${quick.label}(${quick.score.toFixed(2)}) 烈度${quick.heat.toFixed(2)} 来源${quick.heatDriver} | ${quick.comment}`,
        );
        await sendToSavedMessages(client, formatQuickScore(quick));
        return;
      }

      // 第一阶段：只有 score 达标才允许拉行情；纯 heat 触发一律 NO_MARKET。
      // heatDriver 不参与行情路由（先观察其是否稳定）。
      const pullMarket =
        marketAllowedThisRound(scoreTriggered) &&
        (quickDirectionRule?.includeMarket ?? false);
      const marketContext = pullMarket
        ? await buildBatchMarketContext(buffer)
        : NO_MARKET_CONTEXT;
      const result = await analyzeBatch(buffer, marketContext, paceNote);

      // 交易档位由深度轮方向轴复核决定；heat 不能把它抬进交易档。
      const directionRule = resolveEffectiveDirectionTier(
        quickDirectionRule,
        result.score,
      );
      const deepDirectionUpgraded = !scoreTriggered && directionRule !== null;
      const outcome = decideDeepOutcome({
        scoreTriggered,
        hasDirectionTier: directionRule !== null,
        finalHeat: result.heat,
        heatPushThreshold: config.sentiment.heatPushThreshold,
      });
      const finalTier = directionRule?.tier ?? outcome;
      const alertPushed = outcome !== "overheat_silent";

      const log = {
        ...logBase,
        finalScore: result.score,
        finalHeat: result.heat,
        finalHeatDriver: result.heatDriver,
        marketContextLoaded: pullMarket,
        deepDirectionUpgraded,
        alertPushed,
        initialTier: quickDirectionRule?.tier ?? "",
        finalTier,
      };

      persistedBatchId = saveBatch({
        groupId,
        messageIds,
        startTime,
        endTime,
        quickScore: quick.score,
        finalScore: result.score,
        initialTier: quickDirectionRule?.tier ?? null,
        finalTier,
        dominantEmotion: result.dominantEmotion,
        summary: result.summary,
        marketInsight: result.marketInsight,
        result: { quick, analysis: result, log },
        status: "completed",
      });
      emitLog(log);
      console.log(
        `📊 深度分析 | ${outcome} | 交易档:${directionRule?.tier ?? "无"} | ${result.label}(${result.score.toFixed(2)}) 烈度${result.heat.toFixed(2)} 来源${result.heatDriver} | 行情:${pullMarket ? "是" : "否"}`,
      );

      // 方向回落且烈度也降下来：仅发总览。
      if (outcome === "downgraded") {
        await sendToSavedMessages(client, formatDowngradedAnalysis(result));
        return;
      }

      // 纯 heat 触发、finalHeat 未达推送阈值：只落库+日志，不推送。
      if (outcome === "overheat_silent") {
        console.log(
          `🔕 情绪过热但未达推送阈值(${config.sentiment.heatPushThreshold})，仅记录 | 烈度${result.heat.toFixed(2)} 来源${result.heatDriver}`,
        );
        return;
      }

      // 纯 heat 触发、finalHeat 达标：推送情绪过热摘要，无交易内容。
      if (outcome === "overheat_push") {
        await sendToSavedMessages(client, formatOverheatAlert(result));
        return;
      }

      // 纯 heat 触发但 Deep 把 score 抬到方向档：本轮未拉行情，不输出交易内容。
      if (outcome === "direction_upgraded_no_market") {
        await sendToSavedMessages(
          client,
          formatDirectionUpgradedNoMarket(result),
        );
        return;
      }

      // directional：score 达标，走原有方向交易工作流。
      const rule = directionRule!;
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
        rule.includeMarket && result.marketInsight
          ? `\n\n📈 行情视角：${result.marketInsight}`
          : "";

      const msg = [
        `${emoji} 群体情绪告警：${result.label}`,
        ``,
        `📊 情感得分：${(result.score * 100).toFixed(0)}%`,
        formatHeatLine(result.heat),
        `🎭 主导情绪：${result.dominantEmotion}`,
        rule.banner,
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

      if (!rule.runAssetDetail) {
        console.log(`⏭️ 当前档位 ${rule.tier}，仅发送总览`);
        return;
      }

      for (const asset of result.topAssets.slice(0, config.sentiment.assetDetailCount)) {
        const detail = await analyzeAssetDetail(asset, result, buffer);
        await sendToSavedMessages(client, formatAssetDetail(detail));
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);

      // 已落库为 completed：分析本身成功，只是后续发送/单票详情等步骤出错。
      // 不能发「分析失败」误导通知，也不能写 failed 记录，只记日志。
      if (persistedBatchId !== null) {
        console.error("分析已完成落库，但后续发送/单票步骤失败:", err);
        return;
      }

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
          errorMessage: reason,
        });
      } catch (dbErr) {
        console.error("失败记录写入数据库失败:", dbErr);
      }

      // 不把解析失败当成中性数据：明确报错，不产生假的情绪读数。
      console.error("批量分析失败:", err);
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

  // 不做启动预热：历史消息的当日总结交给 `pnpm summary`。
  // 这里只初始化空 buffer，实时消息到达后按 batchSize 进入完整 workflow。
  for (const groupEntity of targetGroupEntities) {
    const groupId = normalizeTelegramId(groupEntity.id.toString());
    messageBuffers.set(groupId, []);
  }

  console.log("✅ 开始监听实时消息\n");

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

// 黑话自动学习：每批消息跑一次资产识别，发现词典里没有的新叫法
// → Yahoo 验证代码真实存在 → 记为 pending → bot 发给你确认（✅/❌）。
// 确认后写入数据库，下一批分析的词典提示立刻带上它。
import {
  dictionaryTerms,
  findNewAliasCandidates,
  loadDictionary,
  MentionedAsset,
  normalizeTerm,
} from "./asset-dictionary";
import { BotTarget, CallbackQuery, sendViaBot } from "./bot-notify";
import {
  decideAlias,
  getAlias,
  insertAliasCandidate,
  listAliases,
  listStalePendingAliases,
  markAliasNotified,
} from "./db";
import { fetchYahooQuote, toYahooSymbol } from "./market-data";
import { aliasCallbackData, formatAliasCandidate, parseAliasCallback } from "./alias-format";

export async function learnAliasesFromMentions(params: {
  groupId: string;
  groupLabel: string;
  mentions: MentionedAsset[];
  bot: BotTarget | null;
}): Promise<void> {
  const { groupId, groupLabel, mentions, bot } = params;
  if (mentions.length === 0) return;

  // 已问过的（任何状态，含已拒绝）都不再问。
  const known = dictionaryTerms(loadDictionary());
  for (const a of listAliases()) known.add(normalizeTerm(a.term));

  const candidates = findNewAliasCandidates(mentions, known);
  for (const m of candidates) {
    const symbol = toYahooSymbol(m);
    const quote = symbol ? await fetchYahooQuote(symbol) : null;
    if (!quote) {
      console.log(`🔎 新叫法「${m.term}」→ ${m.ticker} Yahoo 查不到，跳过`);
      continue;
    }

    const id = insertAliasCandidate({
      term: m.term,
      name: m.name,
      ticker: m.ticker,
      exchange: m.exchange,
      yahooSymbol: quote.symbol,
      yahooName: quote.name,
      evidence: m.evidence,
      groupId,
    });
    if (id === null) continue;

    console.log(`🆕 新黑话候选 #${id}「${m.term}」→ ${m.name} ${m.ticker}`);
    if (!bot) continue;
    await sendAliasPrompt(bot, id, formatAliasCandidate(m, quote, groupLabel));
  }
}

async function sendAliasPrompt(bot: BotTarget, id: number, text: string): Promise<void> {
  await sendViaBot(bot, text, {
    silent: true,
    buttons: [
      [
        { text: "✅ 对，加入词典", callback_data: aliasCallbackData("ok", id) },
        { text: "❌ 不对", callback_data: aliasCallbackData("no", id) },
      ],
    ],
  });
  markAliasNotified(id);
}

// 按钮回调只在监听进程运行时处理；启动时 Telegram 会把 24 小时内攒下的点击补发过来。
// 超过 24 小时的点击（典型是周末）已丢失，这里把仍未决定的候选重新推一次。
export async function resendStalePendingAliases(
  bot: BotTarget,
  groupLabels: Map<string, string>,
): Promise<void> {
  for (const alias of listStalePendingAliases(24)) {
    try {
      // 报价只是参考信息，查不到时用入库时验证过的代码和名称照常重发，不让 Yahoo 故障卡住确认。
      const quote = await fetchYahooQuote(alias.yahooSymbol).catch(() => null);
      // 等报价期间按钮回调可能已经处理了这条，发送前再确认一次仍是 pending。
      if (getAlias(alias.id)?.status !== "pending") continue;
      const text = formatAliasCandidate(
        alias,
        quote ?? { symbol: alias.yahooSymbol, name: alias.yahooName },
        groupLabels.get(alias.groupId) ?? alias.groupId,
        { resend: true },
      );
      await sendAliasPrompt(bot, alias.id, text);
      console.log(`🔁 重发黑话候选 #${alias.id}「${alias.term}」`);
    } catch (err) {
      // 单条失败不影响其余候选；notified_at 不更新，下次启动会再试。
      console.error(`重发黑话候选 #${alias.id}「${alias.term}」失败:`, err);
    }
  }
}

export async function handleAliasCallback(query: CallbackQuery): Promise<string | null> {
  const parsed = parseAliasCallback(query.data);
  if (!parsed) return null;
  const alias = decideAlias(parsed.id, parsed.action === "ok" ? "confirmed" : "rejected");
  if (!alias) return "这条候选已不存在";
  if (alias.status === "confirmed") return `✅ 已加入词典：「${alias.term}」= ${alias.name} ${alias.ticker}`;
  if (alias.status === "rejected") return `❌ 已忽略「${alias.term}」，以后不再提醒`;
  return "状态未变";
}

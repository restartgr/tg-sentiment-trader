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
import { decideAlias, insertAliasCandidate, listAliases } from "./db";
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
    await sendViaBot(bot, formatAliasCandidate(m, quote, groupLabel), {
      silent: true,
      buttons: [
        [
          { text: "✅ 对，加入词典", callback_data: aliasCallbackData("ok", id) },
          { text: "❌ 不对", callback_data: aliasCallbackData("no", id) },
        ],
      ],
    });
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

// 黑话词典：assets.json（手工维护）+ 数据库里经确认的新叫法（自动学习）。
// 每次调用都重新读取，确认一条新叫法后下一批分析立刻生效，无需重启。
import fs from "fs";
import path from "path";
import { listAliases, StoredAlias } from "./db";

export interface AssetEntry {
  nickname: string;
  aliases: string[];
  name: string;
  ticker: string;
  exchange: string;
}

export type MentionKind = "代码" | "正式名" | "俗称";

export interface MentionedAsset {
  term: string; // 群里原样的叫法
  kind: MentionKind; // 只有"俗称"才值得问你确认
  name: string;
  ticker: string;
  exchange: string;
  count: number;
  evidence: string;
}

export function normalizeTerm(term: string): string {
  return term.trim().toLowerCase();
}

function sameAsset(a: Pick<AssetEntry, "ticker" | "exchange">, b: Pick<AssetEntry, "ticker" | "exchange">): boolean {
  return normalizeTerm(a.ticker) === normalizeTerm(b.ticker) && normalizeTerm(a.exchange) === normalizeTerm(b.exchange);
}

function readFileAssets(): AssetEntry[] {
  const localFile = path.join(process.cwd(), "assets.json");
  const demoFile = path.join(process.cwd(), "assets.demo.json");
  const file = fs.existsSync(localFile) ? localFile : demoFile;
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    return Array.isArray(parsed) ? (parsed as AssetEntry[]) : [];
  } catch (err) {
    console.error(`资产映射读取失败，已跳过：${file}`, err);
    return [];
  }
}

// 已确认的新叫法：同一只票就并进它的 aliases，新票则作为新条目追加。
export function mergeConfirmedAliases(
  fileAssets: AssetEntry[],
  confirmed: Pick<StoredAlias, "term" | "name" | "ticker" | "exchange">[],
): AssetEntry[] {
  const merged = fileAssets.map((a) => ({ ...a, aliases: [...(a.aliases ?? [])] }));
  for (const alias of confirmed) {
    const existing = merged.find((a) => sameAsset(a, alias));
    if (existing) {
      if (!existing.aliases.includes(alias.term)) existing.aliases.push(alias.term);
    } else {
      merged.push({
        nickname: alias.term,
        aliases: [],
        name: alias.name,
        ticker: alias.ticker,
        exchange: alias.exchange,
      });
    }
  }
  return merged;
}

export function loadDictionary(): AssetEntry[] {
  let confirmed: StoredAlias[] = [];
  try {
    confirmed = listAliases("confirmed");
  } catch (err) {
    console.error("读取已确认黑话失败，仅使用 assets.json:", err);
  }
  return mergeConfirmedAliases(readFileAssets(), confirmed);
}

export function dictionaryTerms(dictionary: AssetEntry[]): Set<string> {
  const terms = new Set<string>();
  for (const a of dictionary) {
    for (const t of [a.nickname, a.name, a.ticker, ...(a.aliases ?? [])]) {
      if (t) terms.add(normalizeTerm(t));
    }
  }
  return terms;
}

// 从大模型识别结果里挑出值得问你的新叫法：
// - 不在词典、也没被问过（含已拒绝的）；
// - 有明确代码（"未知"不问）；
// - 只问"俗称"：代码、正式名、指数都不问（三菱UFJ、日经、レーザーテック<6920> 不算黑话）；
// - 叫法不含代码本身、也不等于正式名（模型标错时兜底）。
export function findNewAliasCandidates(
  mentions: MentionedAsset[],
  knownTerms: Set<string>,
): MentionedAsset[] {
  const seen = new Set<string>();
  const out: MentionedAsset[] = [];
  for (const m of mentions) {
    const term = normalizeTerm(m.term);
    if (!term || knownTerms.has(term) || seen.has(term)) continue;
    if (m.kind !== "俗称") continue;
    if (!m.ticker || m.ticker === "未知" || m.ticker.startsWith("^")) continue;
    if (term.includes(normalizeTerm(m.ticker))) continue;
    if (term === normalizeTerm(m.name)) continue;
    seen.add(term);
    out.push(m);
  }
  return out;
}

import assert from "node:assert/strict";
import { test } from "node:test";
import { formatAliasCandidate } from "./alias-format";
import {
  closeDatabase,
  decideAlias,
  initDatabase,
  insertAliasCandidate,
  listStalePendingAliases,
  markAliasNotified,
} from "./db";

const candidate = (term: string) => ({
  term,
  name: "铠侠",
  ticker: "285A",
  exchange: "东京证券交易所",
  yahooSymbol: "285A.T",
  yahooName: "KIOXIA",
  evidence: "凯侠空单",
  groupId: "g",
});

test("listStalePendingAliases 只返回超过 24 小时未决定的候选，重推后重新计时", () => {
  closeDatabase();
  const db = initDatabase(":memory:");
  const stale = insertAliasCandidate(candidate("凯侠"))!;
  const fresh = insertAliasCandidate(candidate("铠侠酱"))!;
  const decided = insertAliasCandidate(candidate("凯子"))!;
  db.prepare("UPDATE asset_aliases SET created_at = datetime('now', '-30 hours') WHERE id IN (?, ?)").run(stale, decided);
  decideAlias(decided, "rejected");

  assert.deepEqual(listStalePendingAliases(24).map((a) => a.id), [stale]);
  assert.ok(fresh > 0);

  markAliasNotified(stale);
  assert.deepEqual(listStalePendingAliases(24), []);

  db.prepare("UPDATE asset_aliases SET notified_at = datetime('now', '-25 hours') WHERE id = ?").run(stale);
  assert.deepEqual(listStalePendingAliases(24).map((a) => a.id), [stale]);
  closeDatabase();
});

test("formatAliasCandidate 重发时标题提示按钮已过期，且不显示本批次数", () => {
  const quote = { symbol: "285A.T", name: "KIOXIA", price: 7762, currency: "JPY" };
  const text = formatAliasCandidate(candidate("凯侠"), quote, "谈股论今", { resend: true });
  assert.match(text, /^🔁 新黑话待确认（重发：之前的按钮已过期）/);
  assert.match(text, /📍 谈股论今$/);
  assert.match(formatAliasCandidate({ ...candidate("凯侠"), count: 2 }, quote, "谈股论今"), /本批提到 2 次/);
});

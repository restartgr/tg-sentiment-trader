import assert from "node:assert/strict";
import { test } from "node:test";
import {
  dictionaryTerms,
  findNewAliasCandidates,
  mergeConfirmedAliases,
} from "./asset-dictionary";
import { aliasCallbackData, formatAliasCandidate, parseAliasCallback } from "./alias-format";

const fileAssets = [
  { nickname: "塞子", aliases: ["赛王"], name: "kokusai", ticker: "6525", exchange: "东京证券交易所" },
];

const mention = (term: string, ticker = "8035", kind: "代码" | "正式名" | "俗称" = "俗称") => ({
  term,
  kind,
  name: "东京电子",
  ticker,
  exchange: "东京证券交易所",
  count: 2,
  evidence: "电王今天又拉了",
});

test("mergeConfirmedAliases: 同一只票并入 aliases，新票追加条目", () => {
  const merged = mergeConfirmedAliases(fileAssets, [
    { term: "塞塞", name: "kokusai", ticker: "6525", exchange: "东京证券交易所" },
    { term: "电王", name: "东京电子", ticker: "8035", exchange: "东京证券交易所" },
  ]);
  assert.deepEqual(merged[0].aliases, ["赛王", "塞塞"]);
  assert.equal(merged[1].nickname, "电王");
  assert.deepEqual(fileAssets[0].aliases, ["赛王"], "不改动原数组");
});

test("findNewAliasCandidates: 过滤已知/未知代码/纯代码/重复", () => {
  const known = dictionaryTerms(fileAssets);
  const out = findNewAliasCandidates(
    [
      mention("赛王", "6525"),
      mention("电王"),
      mention("电王"),
      mention("8035"),
      mention("神秘股", "未知"),
      mention(" KOKUSAI ", "6525"),
      mention("东京电子", "8035", "正式名"),
      mention("东京电子"),
      mention("レーザーテック<6920>", "6920"),
      mention("日经", "^N225"),
    ],
    known,
  );
  assert.deepEqual(out.map((m) => m.term), ["电王"]);
});

test("alias 回调编码可往返，非法数据返回 null", () => {
  assert.deepEqual(parseAliasCallback(aliasCallbackData("ok", 12)), { action: "ok", id: 12 });
  assert.deepEqual(parseAliasCallback("alias:no:3"), { action: "no", id: 3 });
  assert.equal(parseAliasCallback("alias:drop:3"), null);
  assert.equal(parseAliasCallback(undefined), null);
});

test("formatAliasCandidate 包含叫法、代码、Yahoo 名称和原话", () => {
  const text = formatAliasCandidate(
    mention("电王"),
    { symbol: "8035.T", name: "TOKYO ELECTRON", price: 25000, currency: "JPY" },
    "测试群",
  );
  for (const part of ["「电王」", "8035", "TOKYO ELECTRON", "电王今天又拉了", "测试群"]) {
    assert.ok(text.includes(part), part);
  }
});

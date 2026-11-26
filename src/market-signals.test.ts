import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyDivergence,
  computeReturns,
  detectSpikes,
  externalVerdict,
  formatSpike,
  parseNikkeiViCsv,
  summarizeOutcomes,
} from "./market-signals";

test("externalVerdict: 群内恐慌 + VIX 高 = 双重确认", () => {
  assert.equal(externalVerdict(-0.8, { vix: { value: 28 }, nikkeiVi: null }), "double_fear");
  assert.equal(externalVerdict(-0.8, { vix: { value: 13 }, nikkeiVi: { value: 18, date: "" } }), "group_overreact_fear");
  assert.equal(externalVerdict(0.85, { vix: { value: 13 }, nikkeiVi: null }), "double_greed");
  assert.equal(externalVerdict(0.85, { vix: { value: 20 }, nikkeiVi: { value: 33, date: "" } }), "group_early_greed");
  assert.equal(externalVerdict(-0.8, { vix: { value: 20 }, nikkeiVi: null }), "neutral");
  assert.equal(externalVerdict(-0.8, { vix: null, nikkeiVi: null }), "unknown");
});

test("classifyDivergence: 恐慌跌得少 / 亢奋涨不动", () => {
  assert.equal(classifyDivergence(-0.8, -0.4), "fear_overreact");
  assert.equal(classifyDivergence(-0.8, -2.1), "fear_aligned");
  assert.equal(classifyDivergence(0.8, 0.2), "greed_exhausted");
  assert.equal(classifyDivergence(0.8, 1.5), "greed_aligned");
  assert.equal(classifyDivergence(0.3, -3), "none");
  assert.equal(classifyDivergence(-0.8, null), "none");
});

test("detectSpikes: 次数和倍数都达标才算，按倍数排序", () => {
  const current = new Map([
    ["8035.T", { count: 25, name: "东京电子" }],
    ["NVDA", { count: 12, name: "NVIDIA" }],
    ["6857.T", { count: 5, name: "爱德万" }],
  ]);
  const history = new Map([
    ["8035.T", { count: 300, name: "东京电子" }], // 100 个窗口 → 平时 3 次
    ["NVDA", { count: 500, name: "NVIDIA" }], // 平时 5 次 → 2.4 倍，不算
  ]);
  const spikes = detectSpikes(current, history, 100, { minCount: 8, ratio: 4, baselineFloor: 0.5 });
  assert.deepEqual(spikes.map((s) => s.symbol), ["8035.T"]);
  assert.equal(spikes[0].baselinePerWindow, 3);
  const text = formatSpike(spikes[0], 30, "测试群", { price: 25000, currency: "JPY", changePercent: -3.2 });
  assert.ok(text.includes("近 30 分钟被提 25 次") && text.includes("-3.20%"));
});

test("detectSpikes: 冷门股平时 0 次用基线下限", () => {
  const spikes = detectSpikes(new Map([["X", { count: 8, name: "X" }]]), new Map(), 50, {
    minCount: 8,
    ratio: 4,
    baselineFloor: 0.5,
  });
  assert.equal(spikes[0].ratio, 16);
});

test("computeReturns: 取告警之后第 1、5 个交易日收盘", () => {
  const day = 86400;
  const alertTs = 10 * day * 1000 + 1000;
  const bars = [9, 10, 11, 12, 13, 14, 15].map((d, i) => ({ time: d * day, close: 100 + i }));
  const r = computeReturns(100, alertTs, bars);
  // 告警后第一根是 day 11（close 102），第五根是 day 15（close 106）
  assert.equal(r.ret1d, 2);
  assert.equal(r.ret5d, 6);
  assert.deepEqual(computeReturns(100, alertTs, bars.slice(0, 4)), { ret1d: 2, ret5d: null });
});

test("summarizeOutcomes: 反转率按方向计算", () => {
  const stats = summarizeOutcomes([
    { kind: "sentiment", direction: -1, ret1d: 1, ret5d: 2 },
    { kind: "sentiment", direction: -1, ret1d: -1, ret5d: -3 },
    { kind: "sentiment", direction: -1, ret1d: null, ret5d: null },
    { kind: "sentiment", direction: 1, ret1d: -1, ret5d: -2 },
    { kind: "mention", direction: 0, ret1d: 1, ret5d: 1 },
  ]);
  const fear = stats.find((s) => s.kind === "sentiment" && s.direction === -1)!;
  assert.equal(fear.alerts, 3);
  assert.equal(fear.evaluated, 2);
  assert.equal(fear.reversalRate, 0.5);
  assert.equal(stats.find((s) => s.direction === 1)!.reversalRate, 1);
  assert.equal(stats.find((s) => s.kind === "mention")!.reversalRate, null);
});

test("parseNikkeiViCsv: 跳过表头和版权行", () => {
  const csv = [
    "Date of Data,Close,Open,High,Low",
    '"2026/11/24","31.51","32.92","42.43","24.97"',
    '"2026/11/25","33.39","41.95","43.23","33.39"',
    '"This material is a copyrightable work of Nikkei."',
  ].join("\n");
  assert.deepEqual(parseNikkeiViCsv(csv), { date: "2026/11/25", close: 33.39 });
  assert.equal(parseNikkeiViCsv("header only"), null);
});

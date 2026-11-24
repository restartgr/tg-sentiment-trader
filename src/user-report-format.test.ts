import assert from "node:assert/strict";
import { test } from "node:test";
import type { UserStockReport } from "./analyzer";
import {
  computeWindow,
  formatNoMessages,
  formatRawMessages,
  formatUserReport,
  parseCliArgs,
  parseHHMM,
  splitForTelegram,
} from "./user-report-format";

const DAY_START = Date.UTC(2026, 10, 24, 15, 0); // 2026-11-25 00:00 JST

test("parseHHMM 解析合法时间并拒绝非法输入", () => {
  assert.equal(parseHHMM("00:00"), 0);
  assert.equal(parseHHMM("12:00"), 720);
  assert.equal(parseHHMM("9:05"), 545);
  assert.equal(parseHHMM("24:00"), 1440);
  assert.throws(() => parseHHMM("12"));
  assert.throws(() => parseHHMM("25:00"));
  assert.throws(() => parseHHMM("12:60"));
});

test("computeWindow 缺省 until 为当前时刻", () => {
  const now = DAY_START + 12 * 3_600_000;
  const window = computeWindow(DAY_START, now, "00:00");
  assert.equal(window.sinceMs, DAY_START);
  assert.equal(window.untilMs, now);
  assert.equal(window.sinceLabel, "00:00");
  assert.equal(window.untilLabel, "12:00");
});

test("computeWindow 支持显式区间并拒绝倒置区间", () => {
  const window = computeWindow(DAY_START, DAY_START, "12:00", "19:00");
  assert.equal(window.untilMs - window.sinceMs, 7 * 3_600_000);
  assert.equal(window.sinceLabel, "12:00");
  assert.equal(window.untilLabel, "19:00");
  assert.throws(() => computeWindow(DAY_START, DAY_START, "19:00", "12:00"));
});

test("parseCliArgs 解析 --since/--until 并拒绝未知参数", () => {
  assert.deepEqual(parseCliArgs([]), { since: "00:00", until: undefined });
  assert.deepEqual(parseCliArgs(["--since", "12:00", "--until", "19:00"]), {
    since: "12:00",
    until: "19:00",
  });
  assert.throws(() => parseCliArgs(["--foo"]));
});

test("formatUserReport 包含股票、观点、原话与行情分析", () => {
  const result: UserStockReport = {
    mood: "收盘前转为谨慎",
    summary: "认为银行股短期见顶。",
    otherTopics: ["投行招聘"],
    stocks: [
      {
        nickname: "三井住友",
        name: "三井住友FG",
        ticker: "8316",
        exchange: "东京",
        stance: "看空",
        hisView: "考虑做空，认为涨了五年。",
        quotes: ["我都想空三井住友了"],
        analysis: "长上影线后回落，【观望】。",
      },
      {
        nickname: "AEON",
        name: "AEON",
        ticker: "未知",
        exchange: "未知",
        stance: "看多",
        hisView: "半开玩笑说要买。",
        quotes: [],
        analysis: "",
      },
    ],
  };
  const window = computeWindow(DAY_START, DAY_START, "12:00", "19:00");
  const report = formatUserReport(result, "skyblue", "2026/11/25", window, 42);

  assert.match(report, /发言追踪 · skyblue · 2026\/11\/25 12:00-19:00 JST/);
  assert.match(report, /发言：42 条/);
  assert.match(report, /1\. 三井住友FG \(8316\) · 看空/);
  assert.match(report, /原话：「我都想空三井住友了」/);
  assert.match(report, /行情分析：长上影线后回落/);
  assert.match(report, /2\. AEON · 看多/);
  assert.doesNotMatch(report, /\(未知\)/);
  assert.match(report, /其他话题：投行招聘/);
});

test("formatNoMessages 与 formatRawMessages", () => {
  const window = computeWindow(DAY_START, DAY_START, "00:00", "12:00");
  assert.equal(
    formatNoMessages("skyblue", "2026/11/25", window),
    "👤 发言追踪 · skyblue · 2026/11/25 00:00-12:00 JST：无发言",
  );
  const raw = formatRawMessages([
    { time: "09:01", text: "第一行\n第二行" },
    { time: "09:02", text: "要有信心" },
  ]);
  assert.equal(raw, "📜 原文（2 条）\n[09:01] 第一行 第二行\n[09:02] 要有信心");
});

test("splitForTelegram 按行切分且每段不超过上限", () => {
  const text = ["a".repeat(30), "b".repeat(30), "c".repeat(30)].join("\n");
  const chunks = splitForTelegram(text, 65);
  assert.deepEqual(chunks, [`${"a".repeat(30)}\n${"b".repeat(30)}`, "c".repeat(30)]);

  const long = splitForTelegram("x".repeat(250), 100);
  assert.equal(long.length, 3);
  assert.ok(long.every((chunk) => chunk.length <= 100));
  assert.equal(long.join(""), "x".repeat(250));
});

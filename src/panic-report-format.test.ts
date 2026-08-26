import assert from "node:assert/strict";
import type { PanicHypeResult } from "./analyzer";
import { formatPanicReport } from "./panic-report-format";

const result: PanicHypeResult = {
  oneLiner: "群聊很热，但交易情绪没有全面失控，多方暂时更响。",
  panicIndex: 48,
  heat: 72,
  heatDriver: "多空分歧",
  stabilityScore: 44,
  stabilityLabel: "一般",
  panicCount: 4,
  hypeCount: 2,
  longBias: 65,
  shortBias: 35,
  dominantSide: "多",
  events: [{ type: "鬼叫", quote: "不要出现在报告里", side: "多", intensity: "强烈" }],
  phaseAnalysis: "开场平静，随后分歧升温，但没有演变为全面恐慌。",
  crowdBehavior: "观点开始抱团，情绪表达快于论据补充。",
  summary: "鬼叫值中等而群聊热度偏高，说明吵闹不完全来自交易恐慌。",
  warning: "单一群聊样本可能放大局部情绪。",
  marketOutlook: "若分歧继续扩散，下一时段波动可能放大；若热度回落则该判断失效。中等置信度。",
  leaderboard: [{ username: "某人", score: 99, panicCount: 3, hypeCount: 0, topQuote: "也不要出现", label: "测试称号" }],
};

const report = formatPanicReport(result, 120, 18, "2026-07-17", "14:30");

assert.match(report, /一句话结论：群聊很热/);
assert.match(report, /120 条消息 \/ 18 位参与者/);
assert.match(report, /情绪演变/);
assert.match(report, /今日总结/);
assert.match(report, /行情推演/);
assert.doesNotMatch(report, /今日片名|群聊天气|下一集预告|片尾彩蛋/);
assert.doesNotMatch(report, /不要出现在报告里|也不要出现|某人|测试称号/);

console.log("✓ PANIC 日报使用自然分析文案，且不展示原话或个人榜单");

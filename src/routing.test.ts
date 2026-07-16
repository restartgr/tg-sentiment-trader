import assert from "node:assert/strict";
import {
  coerceHeatDriver,
  decideDeepOutcome,
  emotionIntensity,
  isHeatTriggered,
  isScoreTriggered,
  marketAllowedThisRound,
  shouldDeepAnalyze,
  triggerReason,
} from "./routing";

const SCORE_MIN = 0.5;
const HEAT_DEEP = 0.6;
const HEAT_PUSH = 0.8;
let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

// 验收1：score=0.7, heat=0.3 —— 按原 Score 工作流。
check("验收1 强方向低烈度：score 触发 → directional", () => {
  const scoreTriggered = isScoreTriggered(0.7, SCORE_MIN);
  assert.equal(scoreTriggered, true);
  assert.equal(isHeatTriggered(0.3, HEAT_DEEP), false);
  assert.equal(shouldDeepAnalyze(0.7, 0.3, SCORE_MIN, HEAT_DEEP), true);
  assert.equal(marketAllowedThisRound(scoreTriggered), true); // 允许拉行情
  assert.equal(
    decideDeepOutcome({
      scoreTriggered,
      hasDirectionTier: true, // resolveTier(0.7) 非空
      finalHeat: 0.3,
      heatPushThreshold: HEAT_PUSH,
    }),
    "directional",
  );
});

// 验收2：score=0.1, heat=0.7 —— Deep，不拉行情，不推送。
check("验收2 中性中高烈度：heat 触发，不拉行情，overheat_silent", () => {
  const scoreTriggered = isScoreTriggered(0.1, SCORE_MIN);
  const heatTriggered = isHeatTriggered(0.7, HEAT_DEEP);
  assert.equal(scoreTriggered, false);
  assert.equal(heatTriggered, true);
  assert.equal(shouldDeepAnalyze(0.1, 0.7, SCORE_MIN, HEAT_DEEP), true);
  assert.equal(marketAllowedThisRound(scoreTriggered), false); // 纯 heat 不拉行情
  assert.equal(
    decideDeepOutcome({
      scoreTriggered,
      hasDirectionTier: false,
      finalHeat: 0.7,
      heatPushThreshold: HEAT_PUSH,
    }),
    "overheat_silent", // 0.7 < 0.8 → 不推送
  );
});

// 验收3：score=0.1, heat=0.85 —— Deep，可推送过热摘要，无交易建议。
check("验收3 中性高烈度：heat 触发，overheat_push", () => {
  const scoreTriggered = isScoreTriggered(0.1, SCORE_MIN);
  assert.equal(
    decideDeepOutcome({
      scoreTriggered,
      hasDirectionTier: false,
      finalHeat: 0.85,
      heatPushThreshold: HEAT_PUSH,
    }),
    "overheat_push",
  );
  assert.equal(marketAllowedThisRound(scoreTriggered), false);
});

// 验收4：Quick score=0.1（heat 触发），Deep score=0.7 —— 记录方向升级，不出交易告警。
check("验收4 Quick/Deep 反转：direction_upgraded_no_market", () => {
  const scoreTriggered = isScoreTriggered(0.1, SCORE_MIN); // false，走 heat 路径
  assert.equal(marketAllowedThisRound(scoreTriggered), false); // 本轮未拉行情
  assert.equal(
    decideDeepOutcome({
      scoreTriggered,
      hasDirectionTier: true, // Deep 把 score 抬到方向档
      finalHeat: 0.7,
      heatPushThreshold: HEAT_PUSH,
    }),
    "direction_upgraded_no_market",
  );
});

// 验收5：高频但冷静（heat 低）+ 方向不足 → 不进 Deep（节奏语义在 prompt 层）。
check("验收5 高频冷静：不进 Deep", () => {
  assert.equal(shouldDeepAnalyze(0.1, 0.3, SCORE_MIN, HEAT_DEEP), false);
});

// 验收6：无明确涨跌证据的争吵 → heatDriver 归"其他或不明"，不默认下跌。
check("验收6 heatDriver 无默认涨跌偏置", () => {
  assert.equal(coerceHeatDriver(undefined), "其他或不明");
  assert.equal(coerceHeatDriver("跌"), "其他或不明"); // 非法枚举
  assert.equal(coerceHeatDriver("market_down"), "其他或不明"); // 旧英文值失效
  assert.equal(coerceHeatDriver("下跌"), "下跌");
  assert.equal(coerceHeatDriver("多空分歧"), "多空分歧");
});

// 独立阈值 + triggerReason
check("独立阈值：score 或 heat 任一达标都触发", () => {
  assert.equal(shouldDeepAnalyze(0.55, 0.1, SCORE_MIN, HEAT_DEEP), true);
  assert.equal(shouldDeepAnalyze(0.1, 0.65, SCORE_MIN, HEAT_DEEP), true);
  assert.equal(shouldDeepAnalyze(0.4, 0.5, SCORE_MIN, HEAT_DEEP), false);
});

check("triggerReason 归类", () => {
  assert.equal(triggerReason(true, true), "both");
  assert.equal(triggerReason(true, false), "score");
  assert.equal(triggerReason(false, true), "heat");
  assert.equal(triggerReason(false, false), "none");
});

// score 工作流方向回落 → downgraded
check("decideDeepOutcome：score 触发但方向回落 → downgraded", () => {
  assert.equal(
    decideDeepOutcome({
      scoreTriggered: true,
      hasDirectionTier: false,
      finalHeat: 0.3,
      heatPushThreshold: HEAT_PUSH,
    }),
    "downgraded",
  );
});

check("emotionIntensity 取方向与烈度的大者", () => {
  assert.equal(emotionIntensity(-0.3, 0.7), 0.7);
  assert.equal(emotionIntensity(-0.8, 0.2), 0.8);
});

console.log(`\n全部 ${passed} 组用例通过`);

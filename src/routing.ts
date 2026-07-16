// 情绪路由的纯函数：只依赖原始数值/枚举，方便单测。
// 第一阶段采用保守路由：
//   - score 或 heat 任一达标都进 Deep；
//   - 交易/行情工作流只由 score 决定；heat 只负责"情绪过热"观察，不触碰交易；
//   - heatDriver 只解释烈度来源，不替代 score 判断方向，第一阶段也不用它路由行情工具。

export type HeatDriver = "上涨" | "下跌" | "多空分歧" | "其他或不明";

export const HEAT_DRIVERS: HeatDriver[] = [
  "上涨",
  "下跌",
  "多空分歧",
  "其他或不明",
];

// 证据不足一律归为"其他或不明"，禁止默认猜测涨跌。
export function coerceHeatDriver(value: unknown): HeatDriver {
  return HEAT_DRIVERS.includes(value as HeatDriver)
    ? (value as HeatDriver)
    : "其他或不明";
}

// 情绪强度：方向轴绝对值与烈度轴取大（仅用于展示/日志，不用于触发决策）。
export function emotionIntensity(score: number, heat: number): number {
  return Math.max(Math.abs(score), heat);
}

// 方向轴是否达标（score 独立阈值）。
export function isScoreTriggered(score: number, scoreMin: number): boolean {
  return Math.abs(score) >= scoreMin;
}

// 烈度轴是否达标（heat 独立阈值，与 score 阈值互不影响）。
export function isHeatTriggered(heat: number, heatDeepMin: number): boolean {
  return heat >= heatDeepMin;
}

// 是否进入 Deep：score 或 heat 任意一个达标即可。
export function shouldDeepAnalyze(
  score: number,
  heat: number,
  scoreMin: number,
  heatDeepMin: number,
): boolean {
  return (
    isScoreTriggered(score, scoreMin) || isHeatTriggered(heat, heatDeepMin)
  );
}

export type TriggerReason = "score" | "heat" | "both" | "none";

export function triggerReason(
  scoreTriggered: boolean,
  heatTriggered: boolean,
): TriggerReason {
  if (scoreTriggered && heatTriggered) return "both";
  if (scoreTriggered) return "score";
  if (heatTriggered) return "heat";
  return "none";
}

// 第一阶段：只有 score 达标才允许拉行情；纯 heat 触发一律 NO_MARKET。
// heatDriver 不参与行情路由（先观察其是否稳定）。
export function marketAllowedThisRound(scoreTriggered: boolean): boolean {
  return scoreTriggered;
}

// 深度分析后的输出决策（纯函数）。
// - directional：score 工作流，深度复核后仍有方向档 → 走原 simple/monitor/detail。
// - downgraded：score 工作流，但深度复核方向回落到无档 → 仅总览。
// - direction_upgraded_no_market：纯 heat 触发（未拉行情），但 Deep 把 score 抬到方向档
//     → 只记录方向升级，不输出没有行情支撑的交易告警。
// - overheat_push：纯 heat 触发、无方向档，且 finalHeat >= 推送阈值 → 推送过热摘要。
// - overheat_silent：纯 heat 触发、无方向档，finalHeat < 推送阈值 → 只落库+日志，不推送。
export type DeepOutcome =
  | "directional"
  | "downgraded"
  | "direction_upgraded_no_market"
  | "overheat_push"
  | "overheat_silent";

export function decideDeepOutcome(params: {
  scoreTriggered: boolean;
  hasDirectionTier: boolean;
  finalHeat: number;
  heatPushThreshold: number;
}): DeepOutcome {
  const { scoreTriggered, hasDirectionTier, finalHeat, heatPushThreshold } =
    params;

  if (scoreTriggered) {
    return hasDirectionTier ? "directional" : "downgraded";
  }

  // 纯 heat 触发路径（本轮未拉行情）。
  if (hasDirectionTier) return "direction_upgraded_no_market";
  return finalHeat >= heatPushThreshold ? "overheat_push" : "overheat_silent";
}

export function heatDriverHeadline(driver: HeatDriver): string {
  switch (driver) {
    case "上涨":
      return "上涨引发的情绪过热";
    case "下跌":
      return "下跌引发的情绪过热";
    case "多空分歧":
      return "市场多空激烈分歧";
    case "其他或不明":
      return "非市场情绪过热或来源不明";
  }
}

export function heatDriverEmoji(driver: HeatDriver): string {
  switch (driver) {
    case "上涨":
      return "🔥📈";
    case "下跌":
      return "🔥📉";
    case "多空分歧":
      return "🔥⚖️";
    case "其他或不明":
      return "🔥💬";
  }
}

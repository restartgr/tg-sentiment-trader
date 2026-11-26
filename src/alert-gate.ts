// 实时告警闸门（纯函数）：所有批次照常落库，只有"夸张"的才推送。
// - 极端：深度复核后 |score| >= minAbsScore 或 heat >= minHeat；
// - 冷却：同一个群在 cooldown 内只推一次，除非这次比上次推送的更极端。
import { emotionIntensity } from "./routing";

export interface AlertThresholds {
  minAbsScore: number;
  minHeat: number;
  cooldownMs: number;
  // 冷却期内要比上次推送强度高出多少才再推（避免同一波情绪反复推）。
  escalationDelta: number;
}

export interface LastAlert {
  at: number;
  intensity: number;
}

export type AlertDecision =
  | { push: true; intensity: number }
  | { push: false; reason: "not_extreme" | "cooldown"; intensity: number };

export function isExtreme(
  score: number,
  heat: number,
  t: Pick<AlertThresholds, "minAbsScore" | "minHeat">,
): boolean {
  return Math.abs(score) >= t.minAbsScore || heat >= t.minHeat;
}

export function decideAlert(params: {
  score: number;
  heat: number;
  now: number;
  last: LastAlert | undefined;
  thresholds: AlertThresholds;
}): AlertDecision {
  const { score, heat, now, last, thresholds } = params;
  const intensity = emotionIntensity(score, heat);

  if (!isExtreme(score, heat, thresholds)) {
    return { push: false, reason: "not_extreme", intensity };
  }
  if (
    last &&
    now - last.at < thresholds.cooldownMs &&
    intensity < last.intensity + thresholds.escalationDelta
  ) {
    return { push: false, reason: "cooldown", intensity };
  }
  return { push: true, intensity };
}

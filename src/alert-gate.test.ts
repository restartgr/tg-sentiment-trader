import assert from "node:assert/strict";
import { test } from "node:test";
import { decideAlert, isExtreme } from "./alert-gate";

const thresholds = {
  minAbsScore: 0.8,
  minHeat: 0.85,
  cooldownMs: 30 * 60_000,
  escalationDelta: 0.05,
};
const T0 = 1_000_000_000;

test("isExtreme: score 或 heat 任一达标", () => {
  assert.equal(isExtreme(0.8, 0.1, thresholds), true);
  assert.equal(isExtreme(-0.85, 0.1, thresholds), true);
  assert.equal(isExtreme(0.2, 0.85, thresholds), true);
  assert.equal(isExtreme(0.79, 0.84, thresholds), false);
});

test("decideAlert: 未达极端不推", () => {
  const d = decideAlert({ score: 0.6, heat: 0.7, now: T0, last: undefined, thresholds });
  assert.deepEqual(d, { push: false, reason: "not_extreme", intensity: 0.7 });
});

test("decideAlert: 首次极端推送", () => {
  const d = decideAlert({ score: -0.9, heat: 0.5, now: T0, last: undefined, thresholds });
  assert.deepEqual(d, { push: true, intensity: 0.9 });
});

test("decideAlert: 冷却期内同等强度不推", () => {
  const d = decideAlert({
    score: 0.9,
    heat: 0.5,
    now: T0 + 10 * 60_000,
    last: { at: T0, intensity: 0.88 },
    thresholds,
  });
  assert.deepEqual(d, { push: false, reason: "cooldown", intensity: 0.9 });
});

test("decideAlert: 冷却期内明显升级仍推", () => {
  const d = decideAlert({
    score: 0.95,
    heat: 0.5,
    now: T0 + 10 * 60_000,
    last: { at: T0, intensity: 0.85 },
    thresholds,
  });
  assert.equal(d.push, true);
});

test("decideAlert: 冷却结束后照常推", () => {
  const d = decideAlert({
    score: 0.85,
    heat: 0.2,
    now: T0 + 31 * 60_000,
    last: { at: T0, intensity: 0.95 },
    thresholds,
  });
  assert.equal(d.push, true);
});

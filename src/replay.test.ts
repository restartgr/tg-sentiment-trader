import assert from "node:assert/strict";
import {
  makeRuleReplayReport,
  replayQuickDecision,
  validateReplaySnapshot,
} from "./replay";
import type { ReplaySnapshot } from "./replay-snapshot";

const snapshot: ReplaySnapshot = {
  schemaVersion: 1,
  batchId: 231,
  input: { quickScore: -0.3, quickHeat: 0.45 },
  historicalResult: { status: "completed", tier: "quick" },
};

assert.deepEqual(replayQuickDecision(snapshot, { scoreMin: 0.5, heatDeepMin: 0.6 }), {
  decision: "quick",
  triggerReason: "none",
});
assert.deepEqual(replayQuickDecision(snapshot, { scoreMin: 0.5, heatDeepMin: 0.4 }), {
  decision: "deep_required",
  triggerReason: "heat",
});

const report = makeRuleReplayReport(snapshot, "snapshot-hash", {
  scoreMin: 0.5,
  heatDeepMin: 0.4,
});
assert.equal(report.mode, "rules_only");
assert.deepEqual(report.comparison, {
  historicalDecision: "quick",
  sameDecision: false,
  historicalThresholdsKnown: false,
});
assert.equal(report.replayResult.decision, "deep_required");
assert.equal(JSON.stringify(report).includes("finalTier"), false);

const legacyReport = makeRuleReplayReport(
  { ...snapshot, historicalResult: { status: "completed", tier: "preheat" } },
  "snapshot-hash",
  { scoreMin: 0.5, heatDeepMin: 0.6 },
);
assert.equal(legacyReport.comparison.historicalDecision, "unknown");
assert.equal(legacyReport.comparison.sameDecision, null);

assert.throws(
  () => validateReplaySnapshot({ ...snapshot, input: { quickScore: -0.3 } }),
  /Invalid replay snapshot/,
);
assert.throws(
  () => replayQuickDecision(snapshot, { scoreMin: -1, heatDeepMin: 0.6 }),
  /Replay thresholds/,
);

console.log("✓ rule replay: fixed input, explicit thresholds, uncertain historical route");

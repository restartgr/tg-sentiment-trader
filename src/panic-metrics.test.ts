import assert from "node:assert/strict";
import { derivePanicMetrics } from "./panic-metrics";

function test(name: string, run: () => void): void {
  run();
  console.log(`✓ ${name}`);
}

test("平静状态保持高稳定性和均衡方向", () => {
  assert.deepEqual(derivePanicMetrics(0, 0, 0, 0), {
    panicIndex: 0,
    heat: 0,
    stabilityScore: 100,
    stabilityLabel: "非常稳定",
    longBias: 50,
    shortBias: 50,
    dominantSide: "均衡",
  });
});

test("稳定性由鬼叫指数和全群烈度共同派生", () => {
  const result = derivePanicMetrics(80, 60, 70, 30);
  assert.equal(result.stabilityScore, 27);
  assert.equal(result.stabilityLabel, "不稳定");
});

test("多空比例归一化且由差值判断方向", () => {
  const long = derivePanicMetrics(0, 0, 80, 80);
  assert.equal(long.longBias + long.shortBias, 100);
  assert.equal(long.dominantSide, "均衡");

  const short = derivePanicMetrics(0, 0, 10, 90);
  assert.equal(short.longBias, 10);
  assert.equal(short.shortBias, 90);
  assert.equal(short.dominantSide, "空");
});

test("异常模型数值被限制在有效范围", () => {
  const result = derivePanicMetrics(120, -20, "bad", 30);
  assert.equal(result.panicIndex, 100);
  assert.equal(result.heat, 0);
  assert.equal(result.longBias, 0);
  assert.equal(result.shortBias, 100);
});

console.log("\n鬼叫指标 4 组用例通过");

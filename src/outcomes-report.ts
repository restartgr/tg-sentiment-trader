// pnpm outcomes：回填告警事后验证，并在终端打印按类型/方向的汇总。
import { initDatabase, listOutcomes } from "./db";
import { summarizeOutcomes } from "./market-signals";
import { evaluatePendingOutcomes } from "./signals-io";

const DIRECTION = (kind: string, d: number) =>
  kind === "mention" ? "提及异动" : d < 0 ? "恐慌告警" : d > 0 ? "亢奋告警" : "中性告警";
const pct = (n: number | null) => (n === null ? "-" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`);

async function main() {
  initDatabase();
  const n = await evaluatePendingOutcomes();
  console.log(`📏 本次回填 ${n} 条\n`);
  const stats = summarizeOutcomes(listOutcomes(1000));
  if (stats.length === 0) {
    console.log("还没有告警记录。");
    return;
  }
  console.log("类型        告警数  已验证  1日均值   5日均值   5日反转率");
  for (const s of stats) {
    console.log(
      [
        DIRECTION(s.kind, s.direction).padEnd(8),
        String(s.alerts).padStart(6),
        String(s.evaluated).padStart(7),
        pct(s.avgRet1d).padStart(9),
        pct(s.avgRet5d).padStart(9),
        (s.reversalRate === null ? "-" : `${(s.reversalRate * 100).toFixed(0)}%`).padStart(9),
      ].join("  "),
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

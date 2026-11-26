import type { OutcomeStat } from "../api/types";
import { useOutcomes } from "../hooks/queries";
import { scoreTone, timestamp } from "../lib/format";

function kindText(kind: string, direction: number) {
  if (kind === "mention") return "提及异动";
  if (direction < 0) return "恐慌告警";
  if (direction > 0) return "亢奋告警";
  return "中性告警";
}

function pct(n: number | null) {
  if (n === null) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function StatRow({ stat }: { stat: OutcomeStat }) {
  return (
    <tr>
      <td>{kindText(stat.kind, stat.direction)}</td>
      <td>
        {stat.alerts}
        <span className="cell-sub">已验证 {stat.evaluated}</span>
      </td>
      <td>
        <span className={`score-value ${scoreTone(stat.avgRet1d)}`}>{pct(stat.avgRet1d)}</span>
      </td>
      <td>
        <span className={`score-value ${scoreTone(stat.avgRet5d)}`}>{pct(stat.avgRet5d)}</span>
      </td>
      <td>{stat.reversalRate === null ? "—" : `${Math.round(stat.reversalRate * 100)}%`}</td>
    </tr>
  );
}

// 告警事后验证：告警后指数/个股 1 日、5 日涨跌，用来校准告警门槛。
export function OutcomePanel() {
  const outcomes = useOutcomes();
  const stats = outcomes.data?.stats ?? [];
  const recent = outcomes.data?.recent ?? [];

  return (
    <section className="panel batches-panel" aria-labelledby="outcomes-title">
      <div className="panel-heading">
        <div>
          <p className="panel-kicker">03 / VALIDATION</p>
          <h2 id="outcomes-title">告警事后验证</h2>
        </div>
        <span className="count-chip">{recent.length} 条最近</span>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>类型</th>
              <th>告警数</th>
              <th>1 日均值</th>
              <th>5 日均值</th>
              <th>5 日反转率</th>
            </tr>
          </thead>
          <tbody>
            {stats.length ? (
              stats.map((stat) => <StatRow key={`${stat.kind}:${stat.direction}`} stat={stat} />)
            ) : (
              <tr>
                <td colSpan={5}>
                  <div className="empty-state">
                    {outcomes.isPending
                      ? "正在读取…"
                      : "还没有告警记录。推送告警后会自动记录，收盘后回填涨跌。"}
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {recent.length > 0 && (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>时间</th>
                <th>类型</th>
                <th>标的</th>
                <th>1 日</th>
                <th>5 日</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((row) => (
                <tr key={row.id}>
                  <td>{timestamp(row.alertTs)}</td>
                  <td>
                    {kindText(row.kind, row.direction)}
                    <span className="cell-sub">{row.label}</span>
                  </td>
                  <td>{row.symbol}</td>
                  <td>
        <span className={`score-value ${scoreTone(row.ret1d)}`}>{pct(row.ret1d)}</span>
      </td>
                  <td>
        <span className={`score-value ${scoreTone(row.ret5d)}`}>{pct(row.ret5d)}</span>
      </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="table-foot">
        反转率：恐慌告警后 5 日上涨、亢奋告警后 5 日下跌的比例。样本少时仅供参考。
      </div>
    </section>
  );
}

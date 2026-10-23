import type { Batch } from "../api/types";
import {
  clamp,
  finiteNumber,
  heatText,
  scoreOf,
  scoreText,
  scoreTone,
  statusText,
  timestamp,
} from "../lib/format";

interface BatchTableProps {
  batches: Batch[];
  loading: boolean;
  onOpenBatch: (id: number) => void;
}

function BatchRow({
  batch,
  onOpenBatch,
}: {
  batch: Batch;
  onOpenBatch: (id: number) => void;
}) {
  const score = scoreOf(batch);
  const heat = finiteNumber(batch.heat);
  const summary = batch.summary || "暂无摘要";

  return (
    <tr>
      <td>
        <button
          className="batch-button"
          type="button"
          onClick={() => onOpenBatch(batch.id)}
        >
          #{batch.id}
        </button>
        <span className="cell-sub">{timestamp(batch.endTime)}</span>
      </td>
      <td>
        <span className={`score-value ${scoreTone(score)}`}>
          {scoreText(score)}
        </span>
      </td>
      <td>
        <div className="heat-cell">
          <span>{heatText(heat)}</span>
          <span className="heat-track">
            <i
              style={{ width: `${Math.round(clamp(heat ?? 0, 0, 1) * 100)}%` }}
            />
          </span>
        </div>
      </td>
      <td className="summary-cell" title={summary}>
        {summary}
      </td>
      <td>
        <span className={`status-badge ${batch.status}`}>
          {statusText(batch.status)}
        </span>
      </td>
    </tr>
  );
}

export function BatchTable({ batches, loading, onOpenBatch }: BatchTableProps) {
  return (
    <section className="panel batches-panel" aria-labelledby="batches-title">
      <div className="panel-heading">
        <div>
          <p className="panel-kicker">02 / ANALYSIS</p>
          <h2 id="batches-title">最近批次</h2>
        </div>
        <span className="count-chip">{batches.length} 条</span>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>批次 / 时间</th>
              <th>方向分数</th>
              <th>Heat</th>
              <th>概览</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            {batches.length ? (
              batches.map((batch) => (
                <BatchRow
                  key={batch.id}
                  batch={batch}
                  onOpenBatch={onOpenBatch}
                />
              ))
            ) : (
              <tr>
                <td colSpan={5}>
                  <div className="empty-state">
                    {loading
                      ? "正在读取批次…"
                      : "暂无批次。先运行 TG 分析任务，再回来查看结果。"}
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="table-foot">点击批次查看摘要、主题与来源消息</div>
    </section>
  );
}

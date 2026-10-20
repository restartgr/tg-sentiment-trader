import { useCallback, useEffect, useRef, useState, type FormEvent, type MouseEvent, type ReactNode } from "react";
import { requestJson, type AgentAnswer, type Batch, type BatchDetail, type RunTrace, type Stats } from "./api";

const numberFormat = new Intl.NumberFormat("zh-CN");
const dateFormat = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Tokyo",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

function timestamp(value: number | string | null | undefined) {
  if (value === null || value === undefined || value === "") return "时间未知";
  const numeric = Number(value);
  const date = Number.isFinite(numeric)
    ? new Date(numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric)
    : new Date(value);
  return Number.isNaN(date.getTime()) ? "时间未知" : dateFormat.format(date);
}

function finiteNumber(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function scoreOf(batch: Batch) {
  return finiteNumber(batch.finalScore) ?? finiteNumber(batch.quickScore);
}

function scoreText(value: number | null) {
  return value === null ? "—" : `${value > 0 ? "+" : ""}${value.toFixed(2)}`;
}

function heatText(value: number | null) {
  return value === null ? "—" : value.toFixed(2);
}

function costText(value: number | null) {
  return typeof value === "number" && Number.isFinite(value) ? `$${value.toFixed(6)}` : "费用未知";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "未知错误";
}

function StatsGrid({ stats }: { stats: Stats | null }) {
  const cards = [
    ["消息总数", stats?.messages, "已存储的群消息"],
    ["分析批次", stats?.batches, "全部批次记录"],
    ["已完成", stats?.completedBatches, "可查看的分析"],
    ["失败批次", stats?.failedBatches, "需要排查的任务"],
  ] as const;
  return (
    <section className="stats-grid" aria-label="数据库概况">
      {cards.map(([label, value, foot], index) => (
        <article className="stat-card" key={label}>
          <span className="stat-label">{label}</span>
          <strong>{value === undefined ? "—" : numberFormat.format(value)}</strong>
          <span className="stat-foot">
            {index > 1 && <span className={`legend-dot ${index === 2 ? "positive" : "negative"}`} />}
            {foot}
          </span>
        </article>
      ))}
    </section>
  );
}

function TrendChart({ batches }: { batches: Batch[] }) {
  const points = batches.slice(0, 24).reverse();
  if (!points.length) {
    return <div className="empty-state compact">还没有批次数据。分析任务完成后，这里会出现趋势。</div>;
  }
  const left = 40;
  const right = 754;
  const top = 12;
  const bottom = 176;
  const series = [
    { name: "score", value: scoreOf, y: (value: number) => top + (1 - (value + 1) / 2) * (bottom - top) },
    { name: "heat", value: (batch: Batch) => finiteNumber(batch.heat), y: (value: number) => top + (1 - value) * (bottom - top) },
  ];
  return (
    <svg viewBox="0 0 780 215" preserveAspectRatio="none" aria-hidden="true">
      {["+1", "0", "−1"].map((label, index) => {
        const y = top + (bottom - top) * index / 2;
        return <g key={label}><line x1={left} y1={y} x2={right} y2={y} className="chart-grid" /><text x={0} y={y + 3} className="chart-axis">{label}</text></g>;
      })}
      {series.map((item) => {
        let path = "";
        let penDown = false;
        const dots: Array<[number, number]> = [];
        points.forEach((batch, index) => {
          const raw = item.value(batch);
          if (raw === null) { penDown = false; return; }
          const value = item.name === "heat" ? Math.max(0, Math.min(1, raw)) : Math.max(-1, Math.min(1, raw));
          const x = points.length === 1 ? (left + right) / 2 : left + (right - left) * index / (points.length - 1);
          const y = item.y(value);
          path += `${penDown ? " L" : " M"}${x.toFixed(1)} ${y.toFixed(1)}`;
          penDown = true;
          dots.push([x, y]);
        });
        return <g key={item.name}>
          {path && <path d={path.trim()} className={`chart-${item.name}`} />}
          {dots.map(([x, y], index) => <circle key={index} cx={x} cy={y} r={3.7} className={`chart-dot-${item.name}`} />)}
        </g>;
      })}
      <text x={left} y={205} className="chart-axis">{timestamp(points[0].endTime)}</text>
      <text x={right} y={205} textAnchor="end" className="chart-axis">{timestamp(points.at(-1)?.endTime)}</text>
    </svg>
  );
}

function BatchTable({ batches, onOpen }: { batches: Batch[]; onOpen: (id: number) => void }) {
  return <section className="panel batches-panel" aria-labelledby="batches-title">
    <div className="panel-heading"><div><p className="panel-kicker">02 / ANALYSIS</p><h2 id="batches-title">最近批次</h2></div><span className="count-chip">{batches.length} 条</span></div>
    <div className="table-scroll"><table>
      <thead><tr><th>批次 / 时间</th><th>方向分数</th><th>Heat</th><th>概览</th><th>状态</th></tr></thead>
      <tbody>{batches.length ? batches.map((batch) => {
        const score = scoreOf(batch);
        const heat = finiteNumber(batch.heat);
        return <tr key={batch.id}>
          <td><button className="batch-button" type="button" onClick={() => onOpen(batch.id)}>#{batch.id}</button><span className="cell-sub">{timestamp(batch.endTime)}</span></td>
          <td><span className={`score-value ${score === null ? "flat" : score > 0 ? "up" : score < 0 ? "down" : "flat"}`}>{scoreText(score)}</span></td>
          <td><div className="heat-cell"><span>{heatText(heat)}</span><span className="heat-track"><i style={{ width: `${Math.round(Math.max(0, Math.min(1, heat ?? 0)) * 100)}%` }} /></span></div></td>
          <td className="summary-cell" title={batch.summary || "暂无摘要"}>{batch.summary || "暂无摘要"}</td>
          <td><span className={`status-badge ${batch.status}`}>{batch.status === "completed" ? "已完成" : "失败"}</span></td>
        </tr>;
      }) : <tr><td colSpan={5}><div className="empty-state">暂无批次。先运行 TG 分析任务，再回来查看结果。</div></td></tr>}</tbody>
    </table></div>
    <div className="table-foot">点击批次查看摘要、主题与来源消息</div>
  </section>;
}

function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return <section className="detail-section"><h3>{title}</h3>{children}</section>;
}

function BatchDrawer({ id, onClose }: { id: number | null; onClose: () => void }) {
  const [detail, setDetail] = useState<BatchDetail | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (id === null) return;
    let active = true;
    requestJson<BatchDetail>(`/api/batches/${id}`)
      .then((value) => { if (active) setDetail(value); })
      .catch((reason: unknown) => { if (active) setError(errorMessage(reason)); });
    return () => { active = false; };
  }, [id]);

  useEffect(() => {
    if (id === null) return;
    document.body.classList.add("detail-open");
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKeyDown);
    return () => { document.body.classList.remove("detail-open"); document.removeEventListener("keydown", onKeyDown); };
  }, [id, onClose]);

  if (id === null) return null;
  const batch = detail?.batch;
  return <div className="detail-overlay">
    <div className="detail-backdrop" onClick={onClose} />
    <aside className="detail-drawer" role="dialog" aria-modal="true" aria-labelledby="detail-title">
      <div className="detail-header"><div><p className="panel-kicker">BATCH DETAIL</p><h2 id="detail-title">批次 #{id}</h2></div><button className="icon-button" type="button" aria-label="关闭详情" onClick={onClose}>×</button></div>
      <div className="detail-content">
        {error ? <div className="empty-state">读取失败：{error}</div> : !batch ? <div className="empty-state">正在读取批次详情…</div> : <>
          <div className="detail-meta">{[batch.groupId, timestamp(batch.startTime), timestamp(batch.endTime), batch.status === "completed" ? "已完成" : "失败"].map((item, index) => <span key={index}>{item}</span>)}</div>
          <div className="detail-score-grid"><div><small>方向分数</small><strong>{scoreText(scoreOf(batch))}</strong></div><div><small>Heat</small><strong>{heatText(finiteNumber(batch.heat))}</strong></div></div>
          <DetailSection title="分析摘要"><p>{batch.summary || "暂无内容"}</p></DetailSection>
          {batch.marketInsight && <DetailSection title="市场洞察"><p>{batch.marketInsight}</p></DetailSection>}
          {batch.hotTopics.length > 0 && <DetailSection title="讨论主题"><div className="topic-list">{batch.hotTopics.map((topic, index) => <span key={index}>{topic}</span>)}</div></DetailSection>}
          <DetailSection title={`来源消息 · ${detail.messageCount} 条`}>
            {detail.messages.length ? <><div className="message-list">{detail.messages.map((message) => <article className="message-card" key={message.id}><div className="message-head"><span>消息 #{message.id} · {message.username || "未知用户"}</span><span>{timestamp(message.messageTs)}</span></div><p>{message.text || "（空消息）"}</p></article>)}</div>{detail.messageCount > detail.messages.length && <p className="subtle-text">仅显示前 {detail.messages.length} 条来源消息。</p>}</> : <p className="subtle-text">此批次没有可显示的来源消息。</p>}
          </DetailSection>
        </>}
      </div>
    </aside>
  </div>;
}

function AgentPanel({ onOpen }: { onOpen: (id: number) => void }) {
  const [question, setQuestion] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [askStatus, setAskStatus] = useState("");
  const [askError, setAskError] = useState(false);
  const [answer, setAnswer] = useState<AgentAnswer | null>(null);
  const [steps, setSteps] = useState("");
  const answerRef = useRef<HTMLElement>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || !question.trim()) return;
    setSubmitting(true);
    setAskError(false);
    setAskStatus("Agent 正在查询本地数据并组织回答，这可能需要几十秒。");
    try {
      const result = await requestJson<AgentAnswer>("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: question.trim() }),
      });
      setAnswer(result);
      setSteps("");
      setAskStatus("");
      requestJson<RunTrace>(`/api/runs/${result.runId}`)
        .then((trace) => {
          const models = trace.events.filter((item) => item.eventType === "model_call" && item.status === "success").length;
          const tools = trace.events.filter((item) => item.eventType === "tool_call" && item.status === "success").length;
          setSteps(`${models} 次模型 · ${tools} 次工具`);
        })
        .catch(() => setSteps("Trace 暂不可用"));
      requestAnimationFrame(() => answerRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
    } catch (reason) {
      setAskError(true);
      setAskStatus(`提问失败：${errorMessage(reason)}`);
    } finally {
      setSubmitting(false);
    }
  }

  function followBatch(event: MouseEvent<HTMLAnchorElement>, id: number) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onOpen(id);
  }

  return <aside className="agent-column" aria-labelledby="agent-title">
    <section className="panel agent-panel">
      <div className="agent-topline"><span className="agent-icon">✦</span><span>LOCAL AGENT</span><span className="agent-ready"><i /> 就绪</span></div>
      <h2 id="agent-title">向数据提问</h2>
      <p className="agent-description">Agent 可查阅本地批次和消息。回答会附上它实际查阅过的批次入口。</p>
      <form onSubmit={submit}>
        <label htmlFor="question-input" className="field-label">你的问题</label>
        <textarea id="question-input" name="question" maxLength={2000} rows={5} placeholder="例如：最近的情绪偏向哪边？哪些批次值得关注？" required value={question} onChange={(event) => setQuestion(event.target.value)} />
        <div className="form-actions"><span>最多 2,000 字</span><button className="primary-button" type="submit" disabled={submitting}>{submitting ? "正在分析…" : <>发送问题 <span aria-hidden="true">↗</span></>}</button></div>
      </form>
      {askStatus && <div className={`ask-status${askError ? " error" : ""}`} role="status">{askStatus}</div>}
    </section>
    {answer && <section ref={answerRef} className="panel answer-panel" aria-live="polite">
      <div className="panel-heading answer-heading"><div><p className="panel-kicker">03 / AGENT ANSWER</p><h2>本次回答</h2></div><span className="cost-chip">{costText(answer.estimatedCostUsd)}</span></div>
      <p className="answer-text">{answer.answer || "（Agent 没有返回文字）"}</p>
      <div className="answer-meta"><span>Run {answer.runId.slice(0, 8)}</span><span>{steps}</span></div>
      <div className="inspected-section"><h3>Agent 查阅过的批次</h3><div className="batch-links">
        {answer.inspectedBatches.length ? answer.inspectedBatches.map((batch) => <a className="batch-link" key={batch.id} href={batch.url} title={batch.summary || `查看批次 #${batch.id}`} onClick={(event) => followBatch(event, batch.id)}>批次 #{batch.id} ↗</a>) : <span className="subtle-text">本次没有查阅具体批次。</span>}
      </div></div>
    </section>}
  </aside>;
}

export default function App() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [updatedAt, setUpdatedAt] = useState("等待数据");
  const [notice, setNotice] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(() => {
    const id = Number(new URLSearchParams(window.location.search).get("batch"));
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  });

  const openBatch = useCallback((id: number) => {
    const url = new URL(window.location.href);
    url.searchParams.set("batch", String(id));
    history.replaceState(null, "", url);
    setSelectedId(id);
  }, []);

  const closeBatch = useCallback(() => {
    const url = new URL(window.location.href);
    url.searchParams.delete("batch");
    history.replaceState(null, "", url);
    setSelectedId(null);
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setNotice("");
    try {
      const [nextStats, result] = await Promise.all([
        requestJson<Stats>("/api/stats"),
        requestJson<{ batches: Batch[] }>("/api/batches?limit=50"),
      ]);
      setStats(nextStats);
      setBatches(Array.isArray(result.batches) ? result.batches : []);
      setUpdatedAt(`更新于 ${dateFormat.format(new Date())}`);
    } catch (reason) {
      setNotice(`读取 Dashboard 失败：${errorMessage(reason)}`);
      setUpdatedAt("数据读取失败");
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  return <div className="page-shell">
    <header className="site-header"><a className="brand" href="/" aria-label="TG Sentiment 首页"><span className="brand-mark" aria-hidden="true"><span /><span /><span /></span><span className="brand-copy"><strong>signalroom</strong><small>TG SENTIMENT LAB</small></span></a><div className="header-right"><span className="mode-pill"><span className="live-dot" />LOCAL MODE</span><span className="header-time">{updatedAt}</span></div></header>
    <main>
      <section className="intro-section"><div><p className="eyebrow">MARKET INTELLIGENCE / TELEGRAM</p><h1>市场情绪<span>总览</span></h1><p className="intro-text">浏览批次趋势，查看分析与来源，并向本地 Agent 追问。</p></div><button className="secondary-button" type="button" disabled={refreshing} onClick={() => void refresh()}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 1-2.4-5.7M20 4v5h-5" /></svg>刷新数据</button></section>
      {notice && <div className="page-notice" role="status">{notice}</div>}
      <StatsGrid stats={stats} />
      <div className="content-grid"><div className="primary-column">
        <section className="panel chart-panel" aria-labelledby="trend-title"><div className="panel-heading"><div><p className="panel-kicker">01 / TREND</p><h2 id="trend-title">情绪趋势</h2></div><div className="chart-legend"><span><i className="legend-line score" />方向分数</span><span><i className="legend-line heat" />Heat</span></div></div><div className="chart-wrap" role="img" aria-label="最近批次的方向分数与 Heat 趋势"><TrendChart batches={batches} /></div><div className="chart-foot"><span>最近最多 24 个批次</span><span>方向分数 −1 至 +1 · Heat 0 至 1</span></div></section>
        <BatchTable batches={batches} onOpen={openBatch} />
      </div><AgentPanel onOpen={openBatch} /></div>
    </main>
    <footer className="site-footer"><span>signalroom / local analysis workspace</span><span>数据仅从当前本地服务读取</span></footer>
    <BatchDrawer key={selectedId ?? "closed"} id={selectedId} onClose={closeBatch} />
  </div>;
}

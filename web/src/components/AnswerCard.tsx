import { useEffect, useRef, type MouseEvent } from "react";
import type { AgentAnswer } from "../api/types";
import { useRunTrace } from "../hooks/queries";
import { costText } from "../lib/format";

function RunSteps({ runId }: { runId: string }) {
  const { data, isPending, isError } = useRunTrace(runId);
  if (isPending) return <span>正在读取 Trace…</span>;
  if (isError) return <span>Trace 暂不可用</span>;
  const succeeded = (type: "model_call" | "tool_call") =>
    data.events.filter(
      (event) => event.eventType === type && event.status === "success",
    ).length;
  return (
    <span>
      {succeeded("model_call")} 次模型 · {succeeded("tool_call")} 次工具
    </span>
  );
}

interface AnswerCardProps {
  answer: AgentAnswer;
  onOpenBatch: (id: number) => void;
}

export function AnswerCard({ answer, onOpenBatch }: AnswerCardProps) {
  const cardRef = useRef<HTMLElement>(null);

  useEffect(() => {
    cardRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [answer.runId]);

  function followBatch(event: MouseEvent<HTMLAnchorElement>, id: number) {
    // 保留浏览器的新标签页打开等行为，只拦截普通左键点击
    const modified =
      event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
    if (event.button !== 0 || modified) return;
    event.preventDefault();
    onOpenBatch(id);
  }

  return (
    <section ref={cardRef} className="panel answer-panel" aria-live="polite">
      <div className="panel-heading answer-heading">
        <div>
          <p className="panel-kicker">03 / AGENT ANSWER</p>
          <h2>本次回答</h2>
        </div>
        <span className="cost-chip">{costText(answer.estimatedCostUsd)}</span>
      </div>
      <p className="answer-text">{answer.answer || "（Agent 没有返回文字）"}</p>
      <div className="answer-meta">
        <span>Run {answer.runId.slice(0, 8)}</span>
        <RunSteps runId={answer.runId} />
      </div>
      <div className="inspected-section">
        <h3>Agent 查阅过的批次</h3>
        <div className="batch-links">
          {answer.inspectedBatches.length ? (
            answer.inspectedBatches.map((batch) => (
              <a
                className="batch-link"
                key={batch.id}
                href={batch.url}
                title={batch.summary || `查看批次 #${batch.id}`}
                onClick={(event) => followBatch(event, batch.id)}
              >
                批次 #{batch.id} ↗
              </a>
            ))
          ) : (
            <span className="subtle-text">本次没有查阅具体批次。</span>
          )}
        </div>
      </div>
    </section>
  );
}

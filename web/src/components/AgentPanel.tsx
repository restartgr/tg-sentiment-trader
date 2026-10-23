import { useState, type FormEvent } from "react";
import { isAbortError } from "../api/client";
import { useAskAgent } from "../hooks/queries";
import { errorMessage } from "../lib/format";
import { AnswerCard } from "./AnswerCard";
import { CostSummaryCard } from "./CostSummaryCard";

const MAX_QUESTION_LENGTH = 2000;

function AskStatus({ ask }: { ask: ReturnType<typeof useAskAgent> }) {
  if (ask.isPending) {
    return (
      <div className="ask-status" role="status">
        Agent 正在查询本地数据并组织回答，这可能需要几十秒。
      </div>
    );
  }
  if (ask.isError) {
    const cancelled = isAbortError(ask.error);
    return (
      <div className={`ask-status${cancelled ? "" : " error"}`} role="status">
        {cancelled
          ? "已取消本次提问。"
          : `提问失败：${errorMessage(ask.error)}`}
      </div>
    );
  }
  return null;
}

export function AgentPanel({
  onOpenBatch,
}: {
  onOpenBatch: (id: number) => void;
}) {
  const [question, setQuestion] = useState("");
  const ask = useAskAgent();
  const trimmed = question.trim();
  // 不用 maxLength 截断输入，超长时提示，让用户自己决定删哪部分
  const tooLong = trimmed.length > MAX_QUESTION_LENGTH;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (ask.isPending || !trimmed || tooLong) return;
    ask.mutate(trimmed);
  }

  return (
    <aside className="agent-column" aria-labelledby="agent-title">
      <section className="panel agent-panel">
        <div className="agent-topline">
          <span className="agent-icon">✦</span>
          <span>LOCAL AGENT</span>
          <span className="agent-ready">
            <i /> {ask.isPending ? "运行中" : "就绪"}
          </span>
        </div>
        <h2 id="agent-title">向数据提问</h2>
        <p className="agent-description">
          Agent 可查阅本地批次和消息。回答会附上它实际查阅过的批次入口。
        </p>
        <form onSubmit={submit}>
          <label htmlFor="question-input" className="field-label">
            你的问题
          </label>
          <textarea
            id="question-input"
            name="question"
            rows={5}
            placeholder="例如：最近的情绪偏向哪边？哪些批次值得关注？"
            required
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            aria-invalid={tooLong}
            aria-describedby={tooLong ? "question-error" : undefined}
          />
          <div className="form-actions">
            {tooLong && (
              <span id="question-error" className="field-error" role="alert">
                问题最多 {MAX_QUESTION_LENGTH} 字，当前 {trimmed.length} 字
              </span>
            )}
            <div className="form-buttons">
              {ask.isPending && (
                <button
                  className="secondary-button"
                  type="button"
                  onClick={ask.cancel}
                >
                  取消
                </button>
              )}
              <button
                className="primary-button"
                type="submit"
                disabled={ask.isPending || !trimmed || tooLong}
              >
                {ask.isPending ? (
                  "正在分析…"
                ) : (
                  <>
                    发送问题 <span aria-hidden="true">↗</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </form>
        <AskStatus ask={ask} />
        <CostSummaryCard />
      </section>
      {ask.data && <AnswerCard answer={ask.data} onOpenBatch={onOpenBatch} />}
    </aside>
  );
}

import { useEffect, type ReactNode } from "react";
import type { BatchDetail } from "../api/types";
import { useBatchDetail } from "../hooks/queries";
import {
  errorMessage,
  finiteNumber,
  heatText,
  scoreOf,
  scoreText,
  statusText,
  timestamp,
} from "../lib/format";

function DetailSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="detail-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function SourceMessages({ detail }: { detail: BatchDetail }) {
  const { messages, messageCount } = detail;
  if (!messages.length) {
    return <p className="subtle-text">此批次没有可显示的来源消息。</p>;
  }
  return (
    <>
      <div className="message-list">
        {messages.map((message) => (
          <article className="message-card" key={message.id}>
            <div className="message-head">
              <span>
                消息 #{message.id} · {message.username || "未知用户"}
              </span>
              <span>{timestamp(message.messageTs)}</span>
            </div>
            <p>{message.text || "（空消息）"}</p>
          </article>
        ))}
      </div>
      {messageCount > messages.length && (
        <p className="subtle-text">仅显示前 {messages.length} 条来源消息。</p>
      )}
    </>
  );
}

function BatchDetailBody({ detail }: { detail: BatchDetail }) {
  const { batch } = detail;
  const meta = [
    batch.groupId,
    timestamp(batch.startTime),
    timestamp(batch.endTime),
    statusText(batch.status),
  ];

  return (
    <>
      <div className="detail-meta">
        {meta.map((item, index) => (
          <span key={index}>{item}</span>
        ))}
      </div>
      <div className="detail-score-grid">
        <div>
          <small>方向分数</small>
          <strong>{scoreText(scoreOf(batch))}</strong>
        </div>
        <div>
          <small>Heat</small>
          <strong>{heatText(finiteNumber(batch.heat))}</strong>
        </div>
      </div>
      <DetailSection title="分析摘要">
        <p>{batch.summary || "暂无内容"}</p>
      </DetailSection>
      {batch.marketInsight && (
        <DetailSection title="市场洞察">
          <p>{batch.marketInsight}</p>
        </DetailSection>
      )}
      {batch.hotTopics.length > 0 && (
        <DetailSection title="讨论主题">
          <div className="topic-list">
            {batch.hotTopics.map((topic, index) => (
              <span key={index}>{topic}</span>
            ))}
          </div>
        </DetailSection>
      )}
      <DetailSection title={`来源消息 · ${detail.messageCount} 条`}>
        <SourceMessages detail={detail} />
      </DetailSection>
    </>
  );
}

interface BatchDrawerProps {
  id: number;
  onClose: () => void;
}

export function BatchDrawer({ id, onClose }: BatchDrawerProps) {
  const { data, error, isPending } = useBatchDetail(id);

  useEffect(() => {
    document.body.classList.add("detail-open");
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.classList.remove("detail-open");
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  let body: ReactNode;
  if (error)
    body = <div className="empty-state">读取失败：{errorMessage(error)}</div>;
  else if (isPending)
    body = <div className="empty-state">正在读取批次详情…</div>;
  else body = <BatchDetailBody detail={data} />;

  return (
    <div className="detail-overlay">
      <div className="detail-backdrop" onClick={onClose} />
      <aside
        className="detail-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="detail-title"
      >
        <div className="detail-header">
          <div>
            <p className="panel-kicker">BATCH DETAIL</p>
            <h2 id="detail-title">批次 #{id}</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="关闭详情"
            onClick={onClose}
            autoFocus
          >
            ×
          </button>
        </div>
        <div className="detail-content">{body}</div>
      </aside>
    </div>
  );
}

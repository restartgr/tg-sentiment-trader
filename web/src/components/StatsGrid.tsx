import type { Stats } from "../api/types";
import { numberFormat } from "../lib/format";

interface StatCard {
  label: string;
  value: number | undefined;
  foot: string;
  tone?: "positive" | "negative";
}

export function StatsGrid({ stats }: { stats: Stats | undefined }) {
  const cards: StatCard[] = [
    { label: "消息总数", value: stats?.messages, foot: "已存储的群消息" },
    { label: "分析批次", value: stats?.batches, foot: "全部批次记录" },
    {
      label: "已完成",
      value: stats?.completedBatches,
      foot: "可查看的分析",
      tone: "positive",
    },
    {
      label: "失败批次",
      value: stats?.failedBatches,
      foot: "需要排查的任务",
      tone: "negative",
    },
  ];

  return (
    <section className="stats-grid" aria-label="数据库概况">
      {cards.map((card) => (
        <article className="stat-card" key={card.label}>
          <span className="stat-label">{card.label}</span>
          <strong>
            {card.value === undefined ? "—" : numberFormat.format(card.value)}
          </strong>
          <span className="stat-foot">
            {card.tone && <span className={`legend-dot ${card.tone}`} />}
            {card.foot}
          </span>
        </article>
      ))}
    </section>
  );
}

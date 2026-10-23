import { useIsFetching, useQueryClient } from "@tanstack/react-query";
import { AgentPanel } from "./components/AgentPanel";
import { BatchDrawer } from "./components/BatchDrawer";
import { BatchTable } from "./components/BatchTable";
import { SiteHeader } from "./components/SiteHeader";
import { StatsGrid } from "./components/StatsGrid";
import { TrendPanel } from "./components/TrendPanel";
import { useBatches, useStats } from "./hooks/queries";
import { useSelectedBatch } from "./hooks/useSelectedBatch";
import { dateFormat, errorMessage } from "./lib/format";

// "刷新数据"按钮负责的查询；批次详情和 trace 不随它刷新
const DASHBOARD_QUERIES: unknown[] = ["stats", "batches", "costs"];

function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M20 11a8 8 0 1 1-2.4-5.7M20 4v5h-5" />
    </svg>
  );
}

export default function App() {
  const queryClient = useQueryClient();
  const stats = useStats();
  const batches = useBatches();
  const { selectedId, openBatch, closeBatch } = useSelectedBatch();
  const refreshing =
    useIsFetching({
      predicate: (query) => DASHBOARD_QUERIES.includes(query.queryKey[0]),
    }) > 0;

  const loadError = stats.error ?? batches.error;
  let updatedAt = "等待数据";
  if (loadError) updatedAt = "数据读取失败";
  else if (batches.dataUpdatedAt) {
    updatedAt = `更新于 ${dateFormat.format(batches.dataUpdatedAt)}`;
  }

  function refresh() {
    void queryClient.invalidateQueries({
      predicate: (query) => DASHBOARD_QUERIES.includes(query.queryKey[0]),
    });
  }

  return (
    <div className="page-shell">
      <SiteHeader updatedAt={updatedAt} />
      <main>
        <section className="intro-section">
          <div>
            <p className="eyebrow">MARKET INTELLIGENCE / TELEGRAM</p>
            <h1>
              市场情绪<span>总览</span>
            </h1>
            <p className="intro-text">
              浏览批次趋势，查看分析与来源，并向本地 Agent 追问。
            </p>
          </div>
          <button
            className="secondary-button"
            type="button"
            disabled={refreshing}
            onClick={refresh}
          >
            <RefreshIcon />
            {refreshing ? "刷新中…" : "刷新数据"}
          </button>
        </section>
        {loadError && (
          <div className="page-notice" role="status">
            读取 Dashboard 失败：{errorMessage(loadError)}
          </div>
        )}
        <StatsGrid stats={stats.data} />
        <div className="content-grid">
          <div className="primary-column">
            <TrendPanel batches={batches.data ?? []} onOpenBatch={openBatch} />
            <BatchTable
              batches={batches.data ?? []}
              loading={batches.isPending}
              onOpenBatch={openBatch}
            />
          </div>
          <AgentPanel onOpenBatch={openBatch} />
        </div>
      </main>
      <footer className="site-footer">
        <span>signalroom / local analysis workspace</span>
        <span>数据仅从当前本地服务读取</span>
      </footer>
      {selectedId !== null && (
        <BatchDrawer key={selectedId} id={selectedId} onClose={closeBatch} />
      )}
    </div>
  );
}

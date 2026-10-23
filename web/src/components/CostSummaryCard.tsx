import type { ReactNode } from "react";
import { useCostSummary } from "../hooks/queries";
import { usdText } from "../lib/format";

// 成本汇总是附加信息：自己请求、自己处理失败，不影响页面其他部分
export function CostSummaryCard() {
  const { data, isPending, isError } = useCostSummary();

  let total = "—";
  let detail: ReactNode;
  if (isPending) detail = "正在统计问答成本…";
  else if (isError) detail = "问答成本暂不可用";
  else if (!data.runs) detail = "还没有问答记录";
  else if (!data.knownRuns) detail = `最近 ${data.runs} 次问答的价格都未知`;
  else {
    total = usdText(data.totalCostUsd);
    detail = (
      <>
        最近 {data.runs} 次问答
        {data.averageCostUsd !== null &&
          ` · 平均 ${usdText(data.averageCostUsd)}/次`}
      </>
    );
  }
  const unknownRuns = data?.knownRuns ? data.unknownRuns : 0;

  return (
    <div className="cost-summary">
      <span className="cost-summary-label">问答成本</span>
      <strong>{total}</strong>
      <span className="cost-summary-detail">{detail}</span>
      {unknownRuns > 0 && (
        <span className="cost-summary-detail warning">
          {unknownRuns} 次价格未知，未计入总额
        </span>
      )}
    </div>
  );
}

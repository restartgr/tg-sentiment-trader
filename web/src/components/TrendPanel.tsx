import { useCallback, useMemo } from "react";
import type { ECElementEvent } from "echarts/core";
import type { Batch } from "../api/types";
import { chartColors, type ChartOption } from "../lib/echarts";
import { clamp, finiteNumber, scoreOf, timestamp } from "../lib/format";
import { EChart } from "./EChart";

const TREND_POINTS = 24;

function buildOption(points: Batch[]): ChartOption {
  const axisLabel = { color: chartColors.axis, fontSize: 11 };
  const lineSeries = (name: string, color: string) => ({
    name,
    type: "line" as const,
    showSymbol: true,
    symbol: "circle",
    symbolSize: 6,
    lineStyle: { width: 2.2, color },
    itemStyle: { color, borderColor: "#fff", borderWidth: 1.5 },
    emphasis: { focus: "series" as const },
  });

  return {
    animationDuration: 400,
    grid: { left: 8, right: 8, top: 36, bottom: 4, containLabel: true },
    legend: {
      top: 0,
      right: 0,
      icon: "roundRect",
      itemWidth: 14,
      itemHeight: 3,
      textStyle: { color: chartColors.text, fontSize: 12 },
    },
    tooltip: {
      trigger: "axis",
      borderColor: chartColors.tooltipBorder,
      textStyle: { color: chartColors.text, fontSize: 12 },
      valueFormatter: (value) =>
        typeof value === "number" ? value.toFixed(2) : "—",
    },
    xAxis: {
      type: "category",
      boundaryGap: false,
      data: points.map((batch) => `#${batch.id} ${timestamp(batch.endTime)}`),
      axisLine: { lineStyle: { color: chartColors.grid } },
      axisTick: { show: false },
      axisLabel: {
        ...axisLabel,
        // 只显示时间，批次号留给 tooltip
        formatter: (label: string) => label.replace(/^#\d+ /, ""),
        hideOverlap: true,
      },
    },
    // 方向分数和 Heat 的取值范围不同，分别用左右两条 y 轴
    yAxis: [
      {
        type: "value",
        min: -1,
        max: 1,
        interval: 0.5,
        axisLabel,
        splitLine: { lineStyle: { color: chartColors.grid, type: "dashed" } },
      },
      {
        type: "value",
        min: 0,
        max: 1,
        interval: 0.25,
        axisLabel: { ...axisLabel, color: chartColors.heat },
        splitLine: { show: false },
      },
    ],
    series: [
      {
        ...lineSeries("方向分数", chartColors.score),
        yAxisIndex: 0,
        data: points.map((batch) => {
          const score = scoreOf(batch);
          return score === null ? null : clamp(score, -1, 1);
        }),
      },
      {
        ...lineSeries("Heat", chartColors.heat),
        yAxisIndex: 1,
        data: points.map((batch) => {
          const heat = finiteNumber(batch.heat);
          return heat === null ? null : clamp(heat, 0, 1);
        }),
      },
    ],
  };
}

interface TrendPanelProps {
  batches: Batch[];
  onOpenBatch: (id: number) => void;
}

export function TrendPanel({ batches, onOpenBatch }: TrendPanelProps) {
  // 接口按时间倒序返回，图表需要从旧到新
  const points = useMemo(
    () => batches.slice(0, TREND_POINTS).reverse(),
    [batches],
  );
  const option = useMemo(() => buildOption(points), [points]);

  const handleClick = useCallback(
    (event: ECElementEvent) => {
      const batch = points[event.dataIndex];
      if (batch) onOpenBatch(batch.id);
    },
    [points, onOpenBatch],
  );

  return (
    <section className="panel chart-panel" aria-labelledby="trend-title">
      <div className="panel-heading">
        <div>
          <p className="panel-kicker">01 / TREND</p>
          <h2 id="trend-title">情绪趋势</h2>
        </div>
      </div>
      {points.length ? (
        <EChart
          className="chart-wrap"
          option={option}
          ariaLabel="最近批次的方向分数与 Heat 趋势"
          onClick={handleClick}
        />
      ) : (
        <div className="empty-state compact">
          还没有批次数据。分析任务完成后，这里会出现趋势。
        </div>
      )}
      <div className="chart-foot">
        <span>最近最多 {TREND_POINTS} 个批次 · 点击数据点查看详情</span>
        <span>方向分数 −1 至 +1（左轴）· Heat 0 至 1（右轴）</span>
      </div>
    </section>
  );
}

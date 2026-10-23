import { useEffect, useRef } from "react";
import type { ECElementEvent, ECharts } from "echarts/core";
import { echarts, type ChartOption } from "../lib/echarts";

interface EChartProps {
  option: ChartOption;
  className?: string;
  ariaLabel?: string;
  onClick?: (event: ECElementEvent) => void;
}

export function EChart({ option, className, ariaLabel, onClick }: EChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ECharts | null>(null);
  // 事件只绑定一次，通过 ref 始终调用最新的回调
  const onClickRef = useRef(onClick);

  useEffect(() => {
    onClickRef.current = onClick;
  }, [onClick]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const chart = echarts.init(container, null, { renderer: "svg" });
    chartRef.current = chart;
    chart.on("click", (event) => onClickRef.current?.(event));

    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(container);
    return () => {
      observer.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    chartRef.current?.setOption(option, { notMerge: true });
  }, [option]);

  return (
    <div
      ref={containerRef}
      className={className}
      role="img"
      aria-label={ariaLabel}
    />
  );
}

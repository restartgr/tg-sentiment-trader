// 按需注册：只启用折线图用到的模块
import * as echarts from "echarts/core";
import { LineChart, type LineSeriesOption } from "echarts/charts";
import {
  GridComponent,
  LegendComponent,
  TooltipComponent,
  type GridComponentOption,
  type LegendComponentOption,
  type TooltipComponentOption,
} from "echarts/components";
import { SVGRenderer } from "echarts/renderers";

echarts.use([
  LineChart,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  SVGRenderer,
]);

export type ChartOption = echarts.ComposeOption<
  | LineSeriesOption
  | GridComponentOption
  | LegendComponentOption
  | TooltipComponentOption
>;

// 与 styles.css 中的颜色变量保持一致
export const chartColors = {
  score: "#0e8a6b",
  heat: "#d4812f",
  axis: "#7b8a86",
  grid: "#e1e8e6",
  text: "#3b4b47",
  tooltipBorder: "#c9d5d2",
};

export { echarts };

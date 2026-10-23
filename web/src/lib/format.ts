import type { Batch } from "../api/types";

export const numberFormat = new Intl.NumberFormat("zh-CN");

export const dateFormat = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Tokyo",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

export function timestamp(value: number | string | null | undefined) {
  if (value === null || value === undefined || value === "") return "时间未知";
  const numeric = Number(value);
  // 兼容秒级和毫秒级时间戳
  const date = Number.isFinite(numeric)
    ? new Date(numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric)
    : new Date(value);
  return Number.isNaN(date.getTime()) ? "时间未知" : dateFormat.format(date);
}

export function finiteNumber(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function scoreOf(batch: Batch) {
  return finiteNumber(batch.finalScore) ?? finiteNumber(batch.quickScore);
}

export function scoreText(value: number | null) {
  return value === null ? "—" : `${value > 0 ? "+" : ""}${value.toFixed(2)}`;
}

export function scoreTone(value: number | null) {
  if (value === null || value === 0) return "flat";
  return value > 0 ? "up" : "down";
}

export function heatText(value: number | null) {
  return value === null ? "—" : value.toFixed(2);
}

export function statusText(status: Batch["status"]) {
  return status === "completed" ? "已完成" : "失败";
}

// 单次回答保留 6 位小数，便于和 trace 对账
export function costText(value: number | null) {
  return typeof value === "number" && Number.isFinite(value)
    ? `$${value.toFixed(6)}`
    : "费用未知";
}

// 汇总金额只需要看量级
export function usdText(value: number) {
  return `$${value.toFixed(value >= 1 ? 2 : 4)}`;
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "未知错误";
}

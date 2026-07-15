import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone";
import utc from "dayjs/plugin/utc";
import {
  closeDatabase,
  getBatchesInRange,
  getDatabaseStats,
  getRecentMessages,
  initDatabase,
} from "./db";

dayjs.extend(utc);
dayjs.extend(timezone);

const JST_TZ = "Asia/Tokyo";

function formatTime(timestamp: number): string {
  return dayjs(timestamp).tz(JST_TZ).format("MM/DD HH:mm:ss");
}

function compactText(text: string, maxLength = 70): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > maxLength
    ? `${oneLine.slice(0, maxLength)}...`
    : oneLine;
}

function main(): void {
  initDatabase();

  const stats = getDatabaseStats();
  console.log("SQLite 数据概览");
  console.table([
    { item: "消息", count: stats.messages },
    { item: "分析批次", count: stats.batches },
    { item: "成功批次", count: stats.completedBatches },
    { item: "失败批次", count: stats.failedBatches },
    { item: "消息关联", count: stats.batchMessageLinks },
  ]);

  const messages = getRecentMessages(10).map((message) => ({
    id: message.id,
    time: formatTime(message.messageTs),
    group: message.groupId,
    user: message.username,
    text: compactText(message.text),
  }));
  console.log("\n最近 10 条消息");
  console.table(messages);

  const batches = getBatchesInRange({ limit: 5 }).map((batch) => ({
    id: batch.id,
    start: formatTime(batch.startTime),
    tier: batch.finalTier ?? batch.initialTier ?? "-",
    score: batch.finalScore ?? batch.quickScore ?? "-",
    status: batch.status,
    summary: compactText(batch.summary),
  }));
  console.log("\n最近 5 个分析批次");
  console.table(batches);

  closeDatabase();
}

main();

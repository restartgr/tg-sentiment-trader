import type { TelegramClient } from "telegram";
import { analyzeUserStocks } from "./analyzer";
import { config } from "./config";
import {
  createTelegramClient,
  fetchMessagesSince,
  formatJSTDateLabel,
  formatJSTTime,
  getSenderName,
  readSessionString,
  resolveGroup,
  sendToSavedMessages,
  todayJSTStart,
} from "./telegram-utils";
import {
  computeWindow,
  formatNoMessages,
  formatRawMessages,
  formatUserReport,
  parseCliArgs,
  splitForTelegram,
  type ReportWindow,
  type UserMessage,
} from "./user-report-format";

export interface UserReportOptions {
  since: string; // HH:MM JST
  until?: string; // HH:MM JST，缺省为当前时刻
}

async function sendChunks(client: TelegramClient, text: string): Promise<void> {
  for (const chunk of splitForTelegram(text)) {
    await sendToSavedMessages(client, chunk);
  }
}

// 拉取所有目标群里指定用户在窗口内的发言（按时间升序）。
async function collectUserMessages(
  client: TelegramClient,
  userId: string,
  window: ReportWindow,
): Promise<{ messages: UserMessage[]; displayName: string | null }> {
  const collected: { date: number; text: string }[] = [];
  let displayName: string | null = null;

  for (const group of config.telegram.targetGroups) {
    const entity = await resolveGroup(client, group);
    const all = await fetchMessagesSince(client, entity, window.sinceMs);
    for (const message of all) {
      const ts = message.date * 1000;
      if (ts < window.sinceMs || ts >= window.untilMs) continue;
      if (message.senderId?.toString() !== userId || !message.text?.trim()) continue;
      collected.push({ date: message.date, text: message.text.trim() });
      // fetchMessagesSince 从新到旧返回，第一条命中即最新显示名。
      if (!displayName) displayName = await getSenderName(message);
    }
  }

  collected.sort((a, b) => a.date - b.date);
  return {
    messages: collected.map((m) => ({ time: formatJSTTime(m.date), text: m.text })),
    displayName,
  };
}

// 复用调用方已连接的 client，便于监听进程内定时触发，避免同一 session 双开。
export async function runUserReport(
  client: TelegramClient,
  options: UserReportOptions,
): Promise<void> {
  const userIds = config.telegram.watchUserIds;
  if (userIds.length === 0) {
    console.log("⚠️ 未配置 TG_WATCH_USER_IDS，跳过发言追踪");
    return;
  }

  const dayStart = todayJSTStart().getTime();
  const dateLabel = formatJSTDateLabel(dayStart);
  const window = computeWindow(dayStart, Date.now(), options.since, options.until);

  for (const userId of userIds) {
    try {
      console.log(`👤 发言追踪 ${userId} · ${window.sinceLabel}-${window.untilLabel} JST`);
      const { messages, displayName } = await collectUserMessages(client, userId, window);
      const name = displayName ?? userId;

      if (messages.length === 0) {
        await sendToSavedMessages(client, formatNoMessages(name, dateLabel, window));
        console.log(`   ${name} 无发言，已发送提示`);
        continue;
      }

      console.log(`   ${name} 发言 ${messages.length} 条，分析中...`);
      const result = await analyzeUserStocks(messages, name);
      const report = formatUserReport(result, name, dateLabel, window, messages.length);
      console.log("\n" + "─".repeat(50) + "\n" + report + "\n" + "─".repeat(50));
      await sendChunks(client, report);
      await sendChunks(client, formatRawMessages(messages));
      console.log(`   ✅ ${name} 发言追踪已发送到「已保存消息」`);
    } catch (error) {
      console.error(`发言追踪失败 ${userId}:`, error);
    }
  }
}

async function main(): Promise<void> {
  if (!readSessionString()) {
    console.error("❌ 未找到 session，请先运行: pnpm auth");
    process.exit(1);
  }

  const options = parseCliArgs(process.argv.slice(2));
  const client = createTelegramClient();
  await client.connect();
  try {
    await runUserReport(client, options);
  } finally {
    await client.disconnect();
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("发言追踪启动失败:", error);
      process.exit(1);
    });
}

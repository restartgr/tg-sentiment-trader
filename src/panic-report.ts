import { config } from "./config";
import { analyzePanicHype } from "./analyzer";
import { buildBenchmarkMarketContext } from "./market-data";
import { formatPanicReport } from "./panic-report-format";
import {
  createTelegramClient,
  fetchMessagesSince,
  formatJSTDateLabel,
  formatJSTTime,
  getSenderName,
  inJSTTradingHours,
  isOwnMessage,
  readSessionString,
  resolveGroup,
  sendToSavedMessages,
  todayJSTRange,
} from "./telegram-utils";

const START_MIN = 9 * 60;
const END_OF_DAY_MIN = 24 * 60;

async function main() {
  if (!readSessionString()) {
    console.error("❌ 未找到 session，请先运行: pnpm auth");
    process.exit(1);
  }

  const currentUnixSec = Math.floor(Date.now() / 1000);
  const currentTime = formatJSTTime(currentUnixSec);
  const [hour, minute] = currentTime.split(":").map(Number);
  if (hour * 60 + minute < START_MIN) {
    console.log("⏳ 当前尚未到 JST 09:00，暂无今日消息可分析");
    return;
  }

  const { start: dayStart } = todayJSTRange();
  const dateLabel = formatJSTDateLabel(dayStart);
  const marketContext = await buildBenchmarkMarketContext(
    config.report.benchmarks,
  );

  const client = createTelegramClient();
  await client.connect();

  console.log(`✅ 已连接 | 分析区间：${dateLabel} 09:00-${currentTime} JST`);
  console.log(`   今日 JST 起点 UTC：${new Date(dayStart).toISOString()}`);

  for (const g of config.telegram.targetGroups) {
    try {
      const entity = await resolveGroup(client, g);
      console.log(`\n📡 分页拉取今日消息...`);

      const allMessages = await fetchMessagesSince(client, entity, dayStart);

      // 过滤：今日 JST 范围内 + 开盘时段
      const filtered = allMessages
        .filter((m) => {
          const ts = m.date * 1000;
          return (
            ts >= dayStart &&
            m.text?.trim() &&
            inJSTTradingHours(m.date, START_MIN, END_OF_DAY_MIN) &&
            !(
              config.telegram.excludeSelf &&
              isOwnMessage(m, config.telegram.myUserId)
            )
          );
        })
        .reverse();

      const todayTotal = allMessages.filter(m => m.date * 1000 >= dayStart && m.text?.trim()).length;
      console.log(`   拉取总计：${allMessages.length} 条 | 今日有文本：${todayTotal} 条 | 分析区间：${filtered.length} 条（09:00-${currentTime} JST）`);

      if (filtered.length === 0) {
        console.log(`   ⚠️ 今日 JST 09:00 至当前暂无可分析消息`);
        continue;
      }

      // 按 senderId 去重（同名不同人不会被合并）；无 senderId 再退回 name。
      // name 仍保留喂给模型。
      const buffer: { username: string; text: string }[] = [];
      const participantKeys = new Set<string>();
      for (const msg of filtered) {
        const name = await getSenderName(msg);
        buffer.push({ username: name, text: msg.text!.trim() });
        participantKeys.add(msg.senderId?.toString() ?? `name:${name}`);
      }

      console.log(`   🤖 AI 分析中...`);
      const participantCount = participantKeys.size;
      const statsContext = [
        `统计区间：JST 09:00-${currentTime}`,
        `消息数：${buffer.length}`,
        `独立发言人数：${participantCount}`,
      ].join("；");
      const result = await analyzePanicHype(buffer, marketContext, statsContext);
      const report = formatPanicReport(
        result,
        buffer.length,
        participantCount,
        dateLabel,
        currentTime,
      );

      console.log("\n" + "─".repeat(50));
      console.log(report);
      console.log("─".repeat(50));

      await sendToSavedMessages(client, report);
      console.log(`\n✅ 报告已发送到「已保存消息」`);
    } catch (err) {
      console.error("分析失败:", err);
    }
  }

  await client.disconnect();
}

main().catch((err) => {
  console.error("启动失败:", err);
  process.exit(1);
});

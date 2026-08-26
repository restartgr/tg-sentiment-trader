import type { PanicHypeResult } from "./analyzer";

function meter(value: number): string {
  const filled = Math.round(value / 10);
  return "█".repeat(filled) + "░".repeat(10 - filled);
}

function fallbackOneLiner(result: PanicHypeResult): string {
  const emotion =
    result.panicIndex >= 60
      ? "交易情绪明显上头"
      : result.panicIndex >= 30
        ? "局部情绪开始冒泡"
        : "交易情绪总体克制";
  const crowd =
    result.heat >= 60
      ? "群聊整体偏吵"
      : result.heat >= 30
        ? "群聊有些升温"
        : "群聊整体安静";
  return `${emotion}，${crowd}，${result.dominantSide}方暂居主画面。`;
}

function compact(text: string, fallback: string): string {
  return text.trim() || fallback;
}

export function formatPanicReport(
  result: PanicHypeResult,
  msgCount: number,
  participantCount: number,
  dateLabel: string,
  currentTime: string,
): string {
  const sideEmoji =
    result.dominantSide === "多" ? "📈" : result.dominantSide === "空" ? "📉" : "↔️";
  const stabilityEmoji =
    result.stabilityScore < 30
      ? "🌋"
      : result.stabilityScore < 50
        ? "⚠️"
        : result.stabilityScore < 70
          ? "😬"
          : "🟢";
  const oneLiner = compact(result.oneLiner, fallbackOneLiner(result));

  return [
    `👻 PANIC 日报 · ${dateLabel} · 09:00-${currentTime} JST`,
    `💬 一句话结论：${oneLiner}`,
    `🔭 样本：${msgCount} 条消息 / ${participantCount} 位参与者`,
    ``,
    `📊 情绪仪表盘`,
    `${stabilityEmoji} 稳定性  ${meter(result.stabilityScore)}  ${result.stabilityScore}/100 · ${result.stabilityLabel}`,
    `😱 鬼叫值  ${meter(result.panicIndex)}  ${result.panicIndex}/100`,
    `🔥 群聊热度 ${meter(result.heat)}  ${result.heat}/100 · ${result.heatDriver}驱动`,
    `${sideEmoji} 多空频道  多 ${result.longBias}% / 空 ${result.shortBias}% · ${result.dominantSide}方占优`,
    `🧮 情绪人数  鬼叫 ${result.panicCount} 人 / 炫耀 ${result.hypeCount} 人`,
    ``,
    `⏱️ 情绪演变`,
    compact(result.phaseAnalysis, "情绪演变不明显，今天更像一集过渡篇。"),
    ``,
    `👥 群体行为`,
    compact(result.crowdBehavior, "样本不足，暂时看不出稳定的群体行为模式。"),
    ``,
    `📝 今日总结`,
    compact(result.summary, "当前样本不足，暂无法形成可靠结论。"),
    ``,
    `🔮 行情推演`,
    compact(result.marketOutlook, "信息不足，暂不推演下一交易时段。"),
    ``,
    `⚡ 风险提示`,
    compact(result.warning, "单一群聊样本可能失真，请结合实际行情观察。"),
    ``,
    `仅供情绪观察，不构成投资建议。`,
  ].join("\n");
}

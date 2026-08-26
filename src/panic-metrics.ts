export type StabilityLabel =
  | "极不稳定"
  | "不稳定"
  | "一般"
  | "较稳定"
  | "非常稳定";

export interface PanicMetrics {
  panicIndex: number;
  heat: number;
  stabilityScore: number;
  stabilityLabel: StabilityLabel;
  longBias: number;
  shortBias: number;
  dominantSide: "多" | "空" | "均衡";
}

function clamp(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(100, numeric));
}

export function derivePanicMetrics(
  rawPanicIndex: unknown,
  rawHeat: unknown,
  rawLongBias: unknown,
  rawShortBias: unknown,
): PanicMetrics {
  const panicIndex = clamp(rawPanicIndex);
  const heat = clamp(rawHeat);
  const stabilityScore = 100 - Math.round(panicIndex * 0.65 + heat * 0.35);
  const stabilityLabel: StabilityLabel =
    stabilityScore < 20
      ? "极不稳定"
      : stabilityScore < 40
        ? "不稳定"
        : stabilityScore < 60
          ? "一般"
          : stabilityScore < 80
            ? "较稳定"
            : "非常稳定";

  const unscaledLongBias = clamp(rawLongBias);
  const unscaledShortBias = clamp(rawShortBias);
  const biasTotal = unscaledLongBias + unscaledShortBias;
  const longBias =
    biasTotal > 0 ? Math.round((unscaledLongBias / biasTotal) * 100) : 50;
  const shortBias = 100 - longBias;
  const dominantSide: PanicMetrics["dominantSide"] =
    longBias - shortBias >= 15
      ? "多"
      : shortBias - longBias >= 15
        ? "空"
        : "均衡";

  return {
    panicIndex,
    heat,
    stabilityScore,
    stabilityLabel,
    longBias,
    shortBias,
    dominantSide,
  };
}

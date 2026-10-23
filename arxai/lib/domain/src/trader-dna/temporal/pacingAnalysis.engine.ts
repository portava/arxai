// ═══════════════════════════════════════════════════════════════════════════
// Pacing Analysis (temporal)
//
// Compares observed inter-trade pacing against the trader's baseline:
//   • medianGapMinutes  current vs baseline-implied (1440 / tradesPerDay)
//   • pacingDeltaRatio  current/baseline (1.0 = on baseline)
//   • burstCount        bursts of ≥3 trades with gaps <5min
//   • pacingState       SLOW / NORMAL / FAST / OVERPACED
//
// Pure. Returns evidence + neutral language; never labels emotion.
// ═══════════════════════════════════════════════════════════════════════════

import { z } from "zod/v4";
import type { Trade } from "../../trade/trade.types";
import type { PersonalBaseline } from "../personalBaseline.engine";

export const PacingStateSchema = z.enum(["SLOW", "NORMAL", "FAST", "OVERPACED"]);
export type PacingState = z.infer<typeof PacingStateSchema>;

export const PacingReportSchema = z.object({
  sample: z.number().int().nonnegative(),
  baselineGapMinutes: z.number().nonnegative(),
  observedMedianGapMinutes: z.number().nonnegative(),
  pacingDeltaRatio: z.number().nonnegative(),
  burstCount: z.number().int().nonnegative(),
  pacingState: PacingStateSchema,
  pacingRiskScore01: z.number().min(0).max(1),
  neutralLanguage: z.string(),
});
export type PacingReport = z.infer<typeof PacingReportSchema>;

export function analyzePacing(
  trades: Trade[], baseline: PersonalBaseline,
): PacingReport {
  const ordered = trades.filter(t => !!t.openedAt)
    .sort((a, b) => new Date(a.openedAt).getTime() - new Date(b.openedAt).getTime());
  if (ordered.length < 2) {
    return { sample: ordered.length, baselineGapMinutes: 0, observedMedianGapMinutes: 0,
      pacingDeltaRatio: 1, burstCount: 0, pacingState: "NORMAL",
      pacingRiskScore01: 0, neutralLanguage: "Insufficient sample to evaluate pacing." };
  }
  const gaps: number[] = [];
  let bursts = 0, run = 1;
  for (let i = 1; i < ordered.length; i++) {
    const g = (new Date(ordered[i].openedAt).getTime() -
               new Date(ordered[i-1].openedAt).getTime()) / 60_000;
    if (g >= 0) gaps.push(g);
    if (g < 5) { run++; if (run >= 3) bursts++; } else run = 1;
  }
  const observed = median(gaps);
  const baselineGap = baseline.tradesPerDay > 0 ? 1440 / baseline.tradesPerDay : observed;
  const ratio = baselineGap > 0 ? observed / baselineGap : 1;
  let state: PacingState;
  if (ratio >= 1.5)      state = "SLOW";
  else if (ratio >= 0.66) state = "NORMAL";
  else if (ratio >= 0.33) state = "FAST";
  else                    state = "OVERPACED";
  const pacingRiskScore01 = clamp01(
    state === "OVERPACED" ? 0.85 :
    state === "FAST"      ? 0.55 :
    state === "SLOW"      ? 0.10 :
                            0.05,
  ) + Math.min(0.15, bursts * 0.05);
  const neutralLanguage = baseline.isMature
    ? `Median gap ${observed.toFixed(1)}m vs baseline ${baselineGap.toFixed(1)}m (×${ratio.toFixed(2)}); ${bursts} burst(s) of ≥3 entries within 5m.`
    : `Pacing observation only — baseline still building.`;
  return { sample: ordered.length, baselineGapMinutes: round2(baselineGap),
    observedMedianGapMinutes: round2(observed), pacingDeltaRatio: round2(ratio),
    burstCount: bursts, pacingState: state,
    pacingRiskScore01: baseline.isMature ? Math.min(1, pacingRiskScore01) : Math.min(0.5, pacingRiskScore01),
    neutralLanguage };
}
function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m-1] + s[m]) / 2;
}
function round2(n: number) { return Math.round(n * 100) / 100; }
function clamp01(n: number) { return Math.max(0, Math.min(1, n)); }

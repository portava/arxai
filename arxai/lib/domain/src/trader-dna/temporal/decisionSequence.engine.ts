// ═══════════════════════════════════════════════════════════════════════════
// Decision Sequence Analysis
//
// Looks at the *ordered* sequence of trade decisions instead of isolated
// events. Detects motifs such as:
//   • CHASE         loss → larger size → loss → even larger size
//   • RETRY_TIGHT   loss → re-entry within seconds at similar level
//   • CALM_REENTRY  loss → patient pause → measured re-entry
//   • ACCELERATE   N consecutive entries with shrinking inter-trade gap
//   • COOL_OFF      successful pause after a streak of losses
//
// Pure. Evidence-based. Neutral language only.
// ═══════════════════════════════════════════════════════════════════════════

import { z } from "zod/v4";
import type { Trade } from "../../trade/trade.types";
import type { PersonalBaseline } from "../personalBaseline.engine";

export const SequenceMotifKindSchema = z.enum([
  "CHASE", "RETRY_TIGHT", "CALM_REENTRY", "ACCELERATE", "COOL_OFF",
]);
export type SequenceMotifKind = z.infer<typeof SequenceMotifKindSchema>;

export const SequenceMotifSchema = z.object({
  kind: SequenceMotifKindSchema,
  severity: z.enum(["LOW", "MEDIUM", "HIGH"]),
  startTradeId: z.string(),
  endTradeId: z.string(),
  evidence: z.record(z.string(), z.unknown()),
  neutralLanguage: z.string(),
});
export type SequenceMotif = z.infer<typeof SequenceMotifSchema>;

export const DecisionSequenceReportSchema = z.object({
  sample: z.number().int().nonnegative(),
  motifs: z.array(SequenceMotifSchema),
  worstSeverity: z.enum(["NONE", "LOW", "MEDIUM", "HIGH"]),
  sequenceRiskScore01: z.number().min(0).max(1),
  reasons: z.array(z.string()),
});
export type DecisionSequenceReport = z.infer<typeof DecisionSequenceReportSchema>;

export function analyzeDecisionSequence(
  trades: Trade[], baseline: PersonalBaseline,
): DecisionSequenceReport {
  const reasons: string[] = [];
  const closed = trades.filter(t => t.closedAt && (t.status === "CLOSED_WIN" || t.status === "CLOSED_LOSS"))
    .sort((a, b) => new Date(a.openedAt).getTime() - new Date(b.openedAt).getTime());
  const motifs: SequenceMotif[] = [];

  if (closed.length < 3) {
    reasons.push("sample <3 trades — sequence motifs not evaluated");
    return { sample: closed.length, motifs, worstSeverity: "NONE",
      sequenceRiskScore01: 0, reasons };
  }

  for (let i = 1; i < closed.length; i++) {
    const prev = closed[i - 1], cur = closed[i];
    const gapMin = (new Date(cur.openedAt).getTime() - new Date(prev.closedAt!).getTime()) / 60_000;
    const sizeRatio = baseline.lotSize.median > 0 ? cur.lotSize / baseline.lotSize.median : 1;
    const prevSizeRatio = baseline.lotSize.median > 0 ? prev.lotSize / baseline.lotSize.median : 1;

    // RETRY_TIGHT — re-entry within 60s of a loss close AT a similar
    // level (entry within ±0.3% of prior entry) to avoid false positives
    // from unrelated quick re-entries in volatile markets.
    if (prev.status === "CLOSED_LOSS" && gapMin >= 0 && gapMin < 1) {
      const denom = Math.abs(prev.entryPrice) || 1;
      const priceDelta = Math.abs(cur.entryPrice - prev.entryPrice) / denom;
      const similarLevel = priceDelta <= 0.003;
      const sameSymbol  = cur.symbol === prev.symbol;
      if (similarLevel && sameSymbol) {
        motifs.push({
          kind: "RETRY_TIGHT", severity: gapMin < 0.25 ? "HIGH" : "MEDIUM",
          startTradeId: String(prev.id), endTradeId: String(cur.id),
          evidence: {
            gapSeconds: Math.round(gapMin * 60),
            entryDeltaPct: round2(priceDelta * 100),
          },
          neutralLanguage: `Re-entry on ${cur.symbol} ${Math.round(gapMin*60)}s after a loss at the same level (Δ${(priceDelta*100).toFixed(2)}%).`,
        });
      }
    }

    // CALM_REENTRY — re-entry after ≥10min pause following a loss
    if (prev.status === "CLOSED_LOSS" && gapMin >= 10 && sizeRatio <= 1.0) {
      motifs.push({
        kind: "CALM_REENTRY", severity: "LOW",
        startTradeId: String(prev.id), endTradeId: String(cur.id),
        evidence: { gapMinutes: Math.round(gapMin), sizeRatio: round2(sizeRatio) },
        neutralLanguage: `Patient re-entry after ${Math.round(gapMin)} min pause at ≤baseline size.`,
      });
    }

    // CHASE — loss followed by escalating size
    if (prev.status === "CLOSED_LOSS" && sizeRatio >= prevSizeRatio * 1.4 && sizeRatio >= 1.5) {
      motifs.push({
        kind: "CHASE", severity: sizeRatio >= 2.5 ? "HIGH" : "MEDIUM",
        startTradeId: String(prev.id), endTradeId: String(cur.id),
        evidence: { sizeRatio: round2(sizeRatio), prevSizeRatio: round2(prevSizeRatio) },
        neutralLanguage: `Size increased to ${round2(sizeRatio)}× baseline immediately after a loss.`,
      });
    }
  }

  // ACCELERATE — sliding window of 4 trades with monotonically shrinking gaps
  for (let i = 3; i < closed.length; i++) {
    const gaps = [1,2,3].map(k => (
      new Date(closed[i-k+1].openedAt).getTime() -
      new Date(closed[i-k].closedAt ?? closed[i-k].openedAt).getTime()
    ) / 60_000);
    if (gaps.every(g => g >= 0) && gaps[0] < gaps[1] && gaps[1] < gaps[2] && gaps[0] < 5) {
      motifs.push({
        kind: "ACCELERATE", severity: gaps[0] < 1 ? "HIGH" : "MEDIUM",
        startTradeId: String(closed[i-3].id), endTradeId: String(closed[i].id),
        evidence: { gapsMinutes: gaps.map(g => round2(g)) },
        neutralLanguage: `Inter-trade gaps shrinking (${gaps.map(g => round2(g)+"m").join(" → ")}).`,
      });
    }
  }

  // COOL_OFF — losing streak of ≥3 followed by ≥30min pause
  let lossStreak = 0;
  for (let i = 0; i < closed.length; i++) {
    if (closed[i].status === "CLOSED_LOSS") lossStreak++;
    else {
      if (lossStreak >= 3 && i > 0) {
        const pauseMin = (new Date(closed[i].openedAt).getTime() -
          new Date(closed[i-1].closedAt!).getTime()) / 60_000;
        if (pauseMin >= 30) {
          motifs.push({
            kind: "COOL_OFF", severity: "LOW",
            startTradeId: String(closed[i-lossStreak].id), endTradeId: String(closed[i].id),
            evidence: { lossStreak, pauseMinutes: Math.round(pauseMin) },
            neutralLanguage: `Cooled off ${Math.round(pauseMin)}m after a ${lossStreak}-loss streak.`,
          });
        }
      }
      lossStreak = 0;
    }
  }

  const worstSeverity: "NONE"|"LOW"|"MEDIUM"|"HIGH" =
    motifs.some(m => m.severity === "HIGH" && m.kind !== "CALM_REENTRY" && m.kind !== "COOL_OFF") ? "HIGH"
  : motifs.some(m => m.severity === "MEDIUM" && m.kind !== "CALM_REENTRY" && m.kind !== "COOL_OFF") ? "MEDIUM"
  : motifs.some(m => m.kind === "CHASE" || m.kind === "ACCELERATE" || m.kind === "RETRY_TIGHT") ? "LOW"
  : "NONE";
  // Risk score from negative motifs only
  const negative = motifs.filter(m => m.kind === "CHASE" || m.kind === "RETRY_TIGHT" || m.kind === "ACCELERATE");
  const sevW = (s: SequenceMotif["severity"]) => s === "HIGH" ? 0.9 : s === "MEDIUM" ? 0.6 : 0.3;
  const sequenceRiskScore01 = negative.length === 0 ? 0
    : Math.min(1, negative.reduce((a, m) => a + sevW(m.severity), 0) / Math.max(3, closed.length));
  reasons.push(`${motifs.length} motifs (${negative.length} risk-bearing)`);
  if (!baseline.isMature) reasons.push("baseline immature — sequence findings advisory only");

  return { sample: closed.length, motifs, worstSeverity,
    sequenceRiskScore01: baseline.isMature ? sequenceRiskScore01 : Math.min(0.5, sequenceRiskScore01), reasons };
}
function round2(n: number) { return Math.round(n * 100) / 100; }

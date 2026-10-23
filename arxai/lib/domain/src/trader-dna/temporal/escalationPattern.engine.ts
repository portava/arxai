// ═══════════════════════════════════════════════════════════════════════════
// Escalation Pattern Detection
//
// Detects monotonic escalation (size and/or frequency growth) across
// consecutive trades. Returns the worst observed escalation slope and a
// risk score in [0..1].
// ═══════════════════════════════════════════════════════════════════════════

import { z } from "zod/v4";
import type { Trade } from "../../trade/trade.types";
import type { PersonalBaseline } from "../personalBaseline.engine";

export const EscalationKindSchema = z.enum(["SIZE", "FREQUENCY", "BOTH"]);
export type EscalationKind = z.infer<typeof EscalationKindSchema>;

export const EscalationReportSchema = z.object({
  sample: z.number().int().nonnegative(),
  detected: z.boolean(),
  kind: EscalationKindSchema.nullable(),
  windowSize: z.number().int().nonnegative(),
  startTradeId: z.string().nullable(),
  endTradeId: z.string().nullable(),
  sizeSlopePerStep: z.number(),
  freqSlopePerStep: z.number(),
  escalationRiskScore01: z.number().min(0).max(1),
  neutralLanguage: z.string(),
});
export type EscalationReport = z.infer<typeof EscalationReportSchema>;

export function detectEscalation(
  trades: Trade[], baseline: PersonalBaseline,
): EscalationReport {
  const ordered = trades.filter(t => !!t.openedAt)
    .sort((a, b) => new Date(a.openedAt).getTime() - new Date(b.openedAt).getTime());
  const N = 4;
  let best: EscalationReport | null = null;
  for (let i = N - 1; i < ordered.length; i++) {
    const win = ordered.slice(i - N + 1, i + 1);
    const sizes = win.map(t => t.lotSize);
    const sizeMonotonic = sizes.every((s, k) => k === 0 || s >= sizes[k - 1]) &&
                          sizes[sizes.length - 1] > sizes[0] * 1.25;
    const gaps: number[] = [];
    for (let k = 1; k < win.length; k++) {
      gaps.push((new Date(win[k].openedAt).getTime() - new Date(win[k-1].openedAt).getTime()) / 60_000);
    }
    const freqMonotonic = gaps.every((g, k) => k === 0 || g <= gaps[k - 1]) &&
                          gaps[gaps.length - 1] < gaps[0] * 0.66;
    const sizeSlope = (sizes[sizes.length - 1] - sizes[0]) / (N - 1);
    const freqSlope = gaps.length ? (gaps[gaps.length - 1] - gaps[0]) / gaps.length : 0;
    let kind: EscalationKind | null = null;
    if (sizeMonotonic && freqMonotonic) kind = "BOTH";
    else if (sizeMonotonic) kind = "SIZE";
    else if (freqMonotonic) kind = "FREQUENCY";
    if (!kind) continue;
    const risk = clamp01(
      (kind === "BOTH" ? 0.85 : kind === "SIZE" ? 0.65 : 0.55) +
      (baseline.lotSize.median > 0 ? Math.min(0.15, (sizes[sizes.length-1] / baseline.lotSize.median - 1) * 0.10) : 0),
    );
    const candidate: EscalationReport = {
      sample: ordered.length, detected: true, kind,
      windowSize: N, startTradeId: String(win[0].id), endTradeId: String(win[N-1].id),
      sizeSlopePerStep: round4(sizeSlope), freqSlopePerStep: round4(freqSlope),
      escalationRiskScore01: baseline.isMature ? risk : Math.min(0.5, risk),
      neutralLanguage:
        kind === "BOTH" ? `Size and frequency both escalating across ${N} trades.`
      : kind === "SIZE" ? `Size escalating across ${N} trades (${sizes[0]} → ${sizes[N-1]}).`
      :                   `Frequency escalating across ${N} trades (gap ${gaps[0]?.toFixed(1)}m → ${gaps[gaps.length-1]?.toFixed(1)}m).`,
    };
    if (!best || candidate.escalationRiskScore01 > best.escalationRiskScore01) best = candidate;
  }
  return best ?? {
    sample: ordered.length, detected: false, kind: null,
    windowSize: N, startTradeId: null, endTradeId: null,
    sizeSlopePerStep: 0, freqSlopePerStep: 0,
    escalationRiskScore01: 0,
    neutralLanguage: "No monotonic escalation detected.",
  };
}
function clamp01(n: number) { return Math.max(0, Math.min(1, n)); }
function round4(n: number) { return Math.round(n * 10000) / 10000; }

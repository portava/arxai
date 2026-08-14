// ═══════════════════════════════════════════════════════════════════════════
// Personal Drawdown Profile
//
// Walks the trader's pnl chronologically to surface drawdown anatomy:
//   • equity curve, running peak, current/max drawdown (% from peak)
//   • current drawdown duration in trades and minutes
//   • average recovery time across past completed drawdowns
//   • drawdownRiskScore01 — combined depth/duration relative to history
//
// Pure. Returns sane zeros on empty input.
// ═══════════════════════════════════════════════════════════════════════════

import { z } from "zod/v4";
import type { Trade } from "../trade/trade.types";

export const DrawdownEpisodeSchema = z.object({
  startedAt: z.string(),
  recoveredAt: z.string().nullable(),
  peakEquity: z.number(),
  troughEquity: z.number(),
  depthPct: z.number().nonnegative(),
  durationMinutes: z.number().nonnegative(),
  trades: z.number().int().nonnegative(),
});
export type DrawdownEpisode = z.infer<typeof DrawdownEpisodeSchema>;

export const PersonalDrawdownProfileSchema = z.object({
  startingEquity: z.number(),
  finalEquity:    z.number(),
  currentDrawdownPct:   z.number().min(0),
  currentDrawdownMinutes: z.number().nonnegative(),
  maxDrawdownPct: z.number().min(0),
  maxDrawdownEpisode: DrawdownEpisodeSchema.nullable(),
  pastEpisodes: z.array(DrawdownEpisodeSchema),
  avgRecoveryMinutes: z.number().nonnegative(),
  drawdownRiskScore01: z.number().min(0).max(1),
  reasons: z.array(z.string()),
});
export type PersonalDrawdownProfile = z.infer<typeof PersonalDrawdownProfileSchema>;

export function buildDrawdownProfile(
  trades: Trade[],
  startingEquity: number = 10_000,
): PersonalDrawdownProfile {
  const closed = trades
    .filter(t => (t.status === "CLOSED_WIN" || t.status === "CLOSED_LOSS" || t.status === "CLOSED_BREAKEVEN") && t.closedAt)
    .sort((a, b) => new Date(a.closedAt!).getTime() - new Date(b.closedAt!).getTime());

  if (closed.length === 0) {
    return {
      startingEquity, finalEquity: startingEquity,
      currentDrawdownPct: 0, currentDrawdownMinutes: 0,
      maxDrawdownPct: 0, maxDrawdownEpisode: null,
      pastEpisodes: [], avgRecoveryMinutes: 0,
      drawdownRiskScore01: 0,
      reasons: ["no closed trades — no drawdown evidence"],
    };
  }

  let equity = startingEquity;
  let peak = startingEquity;
  let peakAt: Date = new Date(closed[0].closedAt!);
  let troughEquity = peak;
  let troughAt: Date = peakAt;
  let inDrawdown = false;
  let dd_startTrades = 0;
  let trades_since_peak = 0;

  const past: DrawdownEpisode[] = [];

  for (const t of closed) {
    equity += t.pnl ?? 0;
    const closedAtD = new Date(t.closedAt!);
    if (equity > peak) {
      // recover / new peak
      if (inDrawdown) {
        past.push({
          startedAt: peakAt.toISOString(),
          recoveredAt: closedAtD.toISOString(),
          peakEquity: peak, troughEquity,
          depthPct: peak > 0 ? ((peak - troughEquity) / peak) * 100 : 0,
          durationMinutes: (closedAtD.getTime() - peakAt.getTime()) / 60_000,
          trades: trades_since_peak,
        });
      }
      peak = equity; peakAt = closedAtD;
      troughEquity = equity; troughAt = closedAtD;
      inDrawdown = false;
      trades_since_peak = 0;
      dd_startTrades = 0;
    } else {
      trades_since_peak += 1;
      if (!inDrawdown) { inDrawdown = true; dd_startTrades = trades_since_peak; }
      if (equity < troughEquity) { troughEquity = equity; troughAt = closedAtD; }
    }
  }
  void dd_startTrades; void troughAt;

  const finalEquity = equity;
  const finalAt = new Date(closed[closed.length - 1].closedAt!);
  const currentDrawdownPct = peak > 0 ? Math.max(0, ((peak - finalEquity) / peak) * 100) : 0;
  const currentDrawdownMinutes = inDrawdown ? (finalAt.getTime() - peakAt.getTime()) / 60_000 : 0;

  // include the still-open episode for max calculation
  const liveEpisode: DrawdownEpisode | null = inDrawdown ? {
    startedAt: peakAt.toISOString(),
    recoveredAt: null,
    peakEquity: peak, troughEquity,
    depthPct: peak > 0 ? ((peak - troughEquity) / peak) * 100 : 0,
    durationMinutes: (finalAt.getTime() - peakAt.getTime()) / 60_000,
    trades: trades_since_peak,
  } : null;

  const allEpisodes = liveEpisode ? [...past, liveEpisode] : past;
  const maxEpisode = allEpisodes.length
    ? allEpisodes.reduce((a, b) => a.depthPct >= b.depthPct ? a : b)
    : null;
  const maxDrawdownPct = maxEpisode?.depthPct ?? 0;

  const recoveries = past.map(e => e.durationMinutes);
  const avgRecoveryMinutes = recoveries.length ? recoveries.reduce((s, x) => s + x, 0) / recoveries.length : 0;

  // Score: combine current depth (vs max) and current duration (vs avg recovery).
  const depthRatio    = maxDrawdownPct > 0 ? Math.min(1, currentDrawdownPct / maxDrawdownPct) : 0;
  const durationRatio = avgRecoveryMinutes > 0 ? Math.min(1, currentDrawdownMinutes / (avgRecoveryMinutes * 1.5)) : 0;
  const drawdownRiskScore01 = clamp01(0.6 * depthRatio + 0.4 * durationRatio);

  const reasons: string[] = [];
  reasons.push(`equity ${startingEquity.toFixed(2)} → ${finalEquity.toFixed(2)}, peak ${peak.toFixed(2)}`);
  reasons.push(`current DD ${currentDrawdownPct.toFixed(2)}% (${currentDrawdownMinutes.toFixed(0)} min) · max DD ${maxDrawdownPct.toFixed(2)}%`);
  if (recoveries.length) reasons.push(`avg recovery time ${avgRecoveryMinutes.toFixed(0)} min over ${recoveries.length} past episode(s)`);

  return {
    startingEquity, finalEquity,
    currentDrawdownPct, currentDrawdownMinutes,
    maxDrawdownPct, maxDrawdownEpisode: maxEpisode,
    pastEpisodes: past, avgRecoveryMinutes,
    drawdownRiskScore01, reasons,
  };
}

function clamp01(x: number): number { return Number.isFinite(x) ? (x < 0 ? 0 : x > 1 ? 1 : x) : 0; }

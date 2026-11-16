// ═══════════════════════════════════════════════════════════════════════════
// Personal Baseline
//
// Builds a rolling baseline of the trader's *normal* behavior. Strong
// behavior judgments must wait until the baseline is mature, otherwise we
// risk labeling a new trader as "elevated risk" simply because we don't
// know what their normal looks like yet.
//
// Maturity gates (any one fails → isMature=false):
//   • sample ≥ 30 closed trades
//   • spans ≥ 10 distinct active days
//
// Pure. Never mutates. Returns p25/p75 percentile bands so callers can
// reason about "is this current observation a real deviation, or noise."
// ═══════════════════════════════════════════════════════════════════════════

import { z } from "zod/v4";
import type { Trade } from "../trade/trade.types";

export const PercentileBandSchema = z.object({
  p25: z.number(),
  median: z.number(),
  p75: z.number(),
});
export type PercentileBand = z.infer<typeof PercentileBandSchema>;

export const PersonalBaselineSchema = z.object({
  sample: z.number().int().nonnegative(),
  activeDays: z.number().int().nonnegative(),
  isMature: z.boolean(),
  maturityReasons: z.array(z.string()),
  tradesPerDay: z.number().nonnegative(),
  lotSize: PercentileBandSchema,
  holdMinutes: PercentileBandSchema,
  rMultiple: PercentileBandSchema,
  winRate01: z.number().min(0).max(1),
  avgRMultiple: z.number(),
  windowStart: z.string().nullable(),
  windowEnd: z.string().nullable(),
});
export type PersonalBaseline = z.infer<typeof PersonalBaselineSchema>;

const MATURE_MIN_SAMPLE = 30;
const MATURE_MIN_DAYS = 10;

export function buildPersonalBaseline(trades: Trade[]): PersonalBaseline {
  const closed = trades.filter(isClosed);
  const days = uniqueDayCount(closed);
  const reasons: string[] = [];
  if (closed.length < MATURE_MIN_SAMPLE) reasons.push(`sample ${closed.length}/${MATURE_MIN_SAMPLE} closed trades`);
  if (days < MATURE_MIN_DAYS)            reasons.push(`activity ${days}/${MATURE_MIN_DAYS} distinct days`);
  const isMature = reasons.length === 0;

  const lots = closed.map(t => t.lotSize);
  const rs   = closed.map(t => t.rMultiple ?? 0);
  const holds = closed
    .filter(t => t.closedAt)
    .map(t => (new Date(t.closedAt!).getTime() - new Date(t.openedAt).getTime()) / 60_000);

  const wins = closed.filter(t => t.status === "CLOSED_WIN").length;
  const winRate01 = closed.length > 0 ? wins / closed.length : 0;
  const tradesPerDay = closed.length / Math.max(1, days);
  const opens = closed.map(t => new Date(t.openedAt).getTime()).sort((a,b) => a-b);

  return {
    sample: closed.length, activeDays: days,
    isMature, maturityReasons: reasons,
    tradesPerDay,
    lotSize: percentiles(lots),
    holdMinutes: percentiles(holds),
    rMultiple: percentiles(rs),
    winRate01,
    avgRMultiple: avg(rs),
    windowStart: opens.length ? new Date(opens[0]).toISOString() : null,
    windowEnd:   opens.length ? new Date(opens[opens.length - 1]).toISOString() : null,
  };
}

// ── helpers ────────────────────────────────────────────────────────────────
function isClosed(t: Trade): boolean {
  return t.status === "CLOSED_WIN" || t.status === "CLOSED_LOSS" || t.status === "CLOSED_BREAKEVEN";
}
function uniqueDayCount(ts: Trade[]): number {
  const set = new Set<string>();
  for (const t of ts) set.add(new Date(t.openedAt).toISOString().slice(0, 10));
  return set.size;
}
function avg(xs: number[]): number { return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0; }
function percentiles(xs: number[]): PercentileBand {
  if (xs.length === 0) return { p25: 0, median: 0, p75: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))];
  return { p25: at(0.25), median: at(0.5), p75: at(0.75) };
}

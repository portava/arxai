import type { Trade } from "../trade/trade.types";
import type {
  BehaviorPattern, DnaSeverity, TraderHistoryWindow, TraderProfile,
} from "./traderProfile.types";

// Per-pattern detection result
export interface BehaviorPatternHit {
  pattern: BehaviorPattern;
  confidence: number;              // 0..100
  severity: DnaSeverity;
  evidence: string[];
}

export interface BehaviorPatternReport {
  hits: BehaviorPatternHit[];
  scannedTrades: number;
  windowDays: number;
}

// ── Aggregator — runs every detector and returns the summary ───────────────
// Each individual detector is exported below so they can be invoked alone
// from the UI for explainability ("why was this pattern flagged?").
export function analyzeBehaviorPatterns(
  profile: TraderProfile,
  window: TraderHistoryWindow,
): BehaviorPatternReport {
  const closed = window.trades.filter((t) => isClosed(t));
  const detectors = [
    detectOvertrading,
    detectFomoChasing,
    detectEarlyExit,
    detectRunnerCutting,
    detectOversizedBets,
  ];
  const hits: BehaviorPatternHit[] = [];
  for (const d of detectors) {
    const hit = d(profile, closed);
    if (hit) hits.push(hit);
  }
  const ms = window.windowEnd.getTime() - window.windowStart.getTime();
  return { hits, scannedTrades: closed.length, windowDays: Math.max(1, Math.round(ms / 86_400_000)) };
}

// ── OVERTRADING ────────────────────────────────────────────────────────────
// Average trades/day in the window > 1.5× baseline → flag.
export function detectOvertrading(profile: TraderProfile, trades: Trade[]): BehaviorPatternHit | null {
  if (trades.length === 0 || profile.baselineTradesPerDay <= 0) return null;
  const days = uniqueDayCount(trades);
  const perDay = trades.length / Math.max(1, days);
  const ratio = perDay / profile.baselineTradesPerDay;
  if (ratio < 1.5) return null;
  return {
    pattern: "OVERTRADING",
    confidence: clampPct(50 + (ratio - 1.5) * 30),
    severity: ratio >= 3 ? "CRITICAL" : ratio >= 2 ? "HIGH" : "MEDIUM",
    evidence: [
      `${perDay.toFixed(1)} trades/day vs baseline ${profile.baselineTradesPerDay.toFixed(1)}`,
      `${ratio.toFixed(2)}× baseline over ${days} day(s)`,
    ],
  };
}

// ── FOMO CHASING ───────────────────────────────────────────────────────────
// Entry placed in trend direction after price already extended (proxy: trade
// stop loss > 2× the median SL distance — chasing cost more risk).
export function detectFomoChasing(_profile: TraderProfile, trades: Trade[]): BehaviorPatternHit | null {
  if (trades.length < 5) return null;
  const slDists = trades.map((t) => Math.abs(t.entryPrice - t.stopLoss)).sort((a, b) => a - b);
  const median = slDists[Math.floor(slDists.length / 2)];
  if (median <= 0) return null;
  const chasers = trades.filter((t) => Math.abs(t.entryPrice - t.stopLoss) > median * 2);
  const ratio = chasers.length / trades.length;
  if (ratio < 0.2) return null;
  return {
    pattern: "FOMO_CHASING",
    confidence: clampPct(40 + ratio * 100),
    severity: ratio >= 0.4 ? "HIGH" : "MEDIUM",
    evidence: [
      `${chasers.length}/${trades.length} entries with SL > 2× median (${median.toFixed(5)})`,
      `Chase ratio ${(ratio * 100).toFixed(0)}%`,
    ],
  };
}

// ── EARLY EXIT ─────────────────────────────────────────────────────────────
// Closed trades with rMultiple between 0.2 and 0.7 (took small wins) make up
// > 35% of wins → habitually exiting before targets.
export function detectEarlyExit(_profile: TraderProfile, trades: Trade[]): BehaviorPatternHit | null {
  const wins = trades.filter((t) => (t.rMultiple ?? 0) > 0);
  if (wins.length < 5) return null;
  const earlies = wins.filter((t) => {
    const r = t.rMultiple ?? 0;
    return r >= 0.2 && r <= 0.7;
  });
  const ratio = earlies.length / wins.length;
  if (ratio < 0.35) return null;
  return {
    pattern: "EARLY_EXIT",
    confidence: clampPct(40 + ratio * 80),
    severity: ratio >= 0.55 ? "HIGH" : "MEDIUM",
    evidence: [
      `${earlies.length}/${wins.length} winners closed at 0.2–0.7R`,
      `Early-exit ratio ${(ratio * 100).toFixed(0)}%`,
    ],
  };
}

// ── RUNNER CUTTING (cuts winners short, lets losers run) ───────────────────
// avg(losing R) magnitude > avg(winning R)
export function detectRunnerCutting(_profile: TraderProfile, trades: Trade[]): BehaviorPatternHit | null {
  const wins = trades.filter((t) => (t.rMultiple ?? 0) > 0);
  const losses = trades.filter((t) => (t.rMultiple ?? 0) < 0);
  if (wins.length < 3 || losses.length < 3) return null;
  const avgWinR = avg(wins.map((t) => t.rMultiple ?? 0));
  const avgLossR = Math.abs(avg(losses.map((t) => t.rMultiple ?? 0)));
  if (avgLossR <= avgWinR) return null;
  const skew = avgLossR / Math.max(0.01, avgWinR);
  return {
    pattern: "RUNNER_CUTTING",
    confidence: clampPct(30 + skew * 25),
    severity: skew >= 2 ? "HIGH" : "MEDIUM",
    evidence: [
      `Avg win ${avgWinR.toFixed(2)}R, avg loss ${avgLossR.toFixed(2)}R`,
      `Loss/Win magnitude ratio ${skew.toFixed(2)}`,
    ],
  };
}

// ── OVERSIZED BETS ─────────────────────────────────────────────────────────
// Recent lot sizes > 1.75× baseline.
export function detectOversizedBets(profile: TraderProfile, trades: Trade[]): BehaviorPatternHit | null {
  if (trades.length === 0 || profile.baselineLotSize <= 0) return null;
  const oversized = trades.filter((t) => t.lotSize > profile.baselineLotSize * 1.75);
  const ratio = oversized.length / trades.length;
  if (ratio < 0.2) return null;
  return {
    pattern: "OVERSIZED_BETS",
    confidence: clampPct(40 + ratio * 100),
    severity: ratio >= 0.4 ? "HIGH" : "MEDIUM",
    evidence: [
      `${oversized.length}/${trades.length} trades >1.75× baseline lot (${profile.baselineLotSize})`,
      `Oversize ratio ${(ratio * 100).toFixed(0)}%`,
    ],
  };
}

// ── helpers ────────────────────────────────────────────────────────────────
function isClosed(t: Trade): boolean {
  return t.status === "CLOSED_WIN" || t.status === "CLOSED_LOSS" || t.status === "CLOSED_BREAKEVEN";
}
function uniqueDayCount(trades: Trade[]): number {
  const days = new Set(trades.map((t) => new Date(t.openedAt).toISOString().slice(0, 10)));
  return days.size;
}
function avg(xs: number[]): number { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }
function clampPct(n: number): number { return Math.max(0, Math.min(100, Math.round(n))); }

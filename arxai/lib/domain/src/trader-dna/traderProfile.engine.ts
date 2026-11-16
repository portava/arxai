// ═══════════════════════════════════════════════════════════════════════════
// Trader Profile builder — derives baseline trade frequency, lot size,
// win rate, R-multiple, and a composed TraderRiskScore from a closed-trade
// history + (optional) detected behavior/revenge/overtrade reports.
//
// Composes:
//   traderRiskScore = clamp01(
//        0.40 · revenge01
//      + 0.25 · overtrade01
//      + 0.20 · behavior01
//      + 0.15 · edgeWeakness01)
//
// Permission ladder:
//   score ≥ 0.85           → LOCKDOWN  / HARD_BLOCK
//   score ≥ 0.65           → COOLDOWN  / COOLDOWN
//   score ≥ 0.45           → MICRO     / REDUCE_SIZE
//   score ≥ 0.25           → REDUCED   / REDUCE_SIZE
//   else                   → FULL      / EXECUTE
//
// Pure. Never throws. Never mutates inputs.
// ═══════════════════════════════════════════════════════════════════════════

import type { Trade } from "../trade/trade.types";
import {
  type TraderProfile, type DnaSeverity,
} from "./traderProfile.types";
import {
  type TraderRiskScore, type PermissionLevel,
  type TraderRecommendedAction,
} from "./traderDNA.types";
import type { BehaviorPatternHit } from "./behaviorPattern.engine";
import type { RevengeTradeReport } from "./revengeTradingDetector.engine";
import type { OvertradeReport } from "./overtradeGuard.engine";

const SEVERITY_TO_01: Record<DnaSeverity, number> = {
  NONE: 0, LOW: 0.20, MEDIUM: 0.45, HIGH: 0.70, CRITICAL: 1.0,
};

export interface BuildProfileInput {
  id: string;
  name: string;
  trades: Trade[];
  windowDays?: number;
}

export function buildTraderProfile(input: BuildProfileInput): TraderProfile {
  const closed = input.trades.filter(t => t.status === "CLOSED_WIN" || t.status === "CLOSED_LOSS" || t.status === "CLOSED_BREAKEVEN");
  const days = Math.max(1, input.windowDays ?? distinctDays(closed));
  const baselineTradesPerDay = closed.length / days;
  const baselineLotSize = avg(closed.map(t => t.lotSize));
  const wins = closed.filter(t => t.status === "CLOSED_WIN").length;
  const baselineWinRate = closed.length > 0 ? wins / closed.length : 0;
  const baselineAvgRMultiple = avg(closed.map(t => t.rMultiple ?? 0));

  return {
    id: input.id, name: input.name, traits: [],
    baselineTradesPerDay, baselineLotSize, baselineWinRate, baselineAvgRMultiple,
    observedPatterns: [],
    preferredSessions: [], avoidedSessions: [],
    lastUpdatedAt: new Date().toISOString(),
  };
}

export interface TraderRiskInput {
  patterns?: BehaviorPatternHit[];
  revenge?: RevengeTradeReport | null;
  overtrade?: OvertradeReport | null;
  personalEdgeScore01?: number;        // 0..1; lower = weaker edge
}

export function computeTraderRiskScore(input: TraderRiskInput): TraderRiskScore {
  const reasons: string[] = [];
  const warnings: string[] = [];

  const revenge01 = SEVERITY_TO_01[input.revenge?.severity ?? "NONE"] *
                    (input.revenge?.detected ? 1 : 0);
  const overtrade01 = SEVERITY_TO_01[input.overtrade?.severity ?? "NONE"] *
                      (input.overtrade?.detected ? 1 : 0);
  const behavior01 = (input.patterns ?? [])
    .map(h => SEVERITY_TO_01[h.severity])
    .reduce((a, b) => Math.max(a, b), 0);
  const edgeWeakness01 = clamp01(1 - (input.personalEdgeScore01 ?? 0.5));

  const score01 = clamp01(
    0.40 * revenge01 + 0.25 * overtrade01 + 0.20 * behavior01 + 0.15 * edgeWeakness01,
  );
  reasons.push(`revenge ${revenge01.toFixed(2)} · overtrade ${overtrade01.toFixed(2)} · behavior ${behavior01.toFixed(2)} · edgeWeakness ${edgeWeakness01.toFixed(2)} → ${score01.toFixed(2)}`);

  let level: DnaSeverity;
  let permission: PermissionLevel;
  let recommendedAction: TraderRecommendedAction;
  if (score01 >= 0.85)      { level = "CRITICAL"; permission = "LOCKDOWN"; recommendedAction = "HARD_BLOCK"; }
  else if (score01 >= 0.65) { level = "HIGH";     permission = "COOLDOWN"; recommendedAction = "COOLDOWN"; }
  else if (score01 >= 0.45) { level = "MEDIUM";   permission = "MICRO";    recommendedAction = "REDUCE_SIZE"; }
  else if (score01 >= 0.25) { level = "LOW";      permission = "REDUCED";  recommendedAction = "REDUCE_SIZE"; }
  else                      { level = "NONE";     permission = "FULL";     recommendedAction = "EXECUTE"; }

  if (input.revenge?.detected) warnings.push(`revenge trading flagged (${input.revenge.severity})`);
  if (input.overtrade?.detected) warnings.push(`overtrading flagged (${input.overtrade.severity})`);
  if (edgeWeakness01 >= 0.6) warnings.push(`personal edge is weak (score ${(input.personalEdgeScore01 ?? 0).toFixed(2)})`);

  reasons.push(`permission ${permission} → ${recommendedAction}`);
  return {
    score01, level,
    components: { revenge01, overtrade01, behavior01, edgeWeakness01 },
    permission, recommendedAction, reasons, warnings,
  };
}

// ── helpers ──────────────────────────────────────────────────────────────
function avg(xs: number[]): number { return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0; }
function distinctDays(ts: Trade[]): number {
  const set = new Set<string>();
  for (const t of ts) set.add(new Date(t.openedAt).toISOString().slice(0, 10));
  return set.size || 1;
}
function clamp01(x: number): number { return Number.isFinite(x) ? (x < 0 ? 0 : x > 1 ? 1 : x) : 0; }

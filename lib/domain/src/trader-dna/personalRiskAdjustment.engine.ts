import type { RiskLimits } from "../risk/riskProfile.types";
import type { BehaviorPatternHit } from "./behaviorPattern.engine";
import type { OvertradeReport } from "./overtradeGuard.engine";
import type { RevengeTradeReport } from "./revengeTradingDetector.engine";

export interface PersonalRiskAdjustment {
  adjustedLimits: RiskLimits;
  changes: AdjustmentChange[];
  appliedReasons: string[];
}

export interface AdjustmentChange {
  field: keyof RiskLimits;
  before: number;
  after: number;
  delta: number;       // signed multiplier or absolute delta — captured in `note`
  note: string;
}

// Each adjustment rule produces a partial change set. We compose them so the
// strongest reduction across all rules wins per field (we never *increase*
// risk based on detected bad behavior).
export function adjustRiskForBehavior(input: {
  baseline: RiskLimits;
  patterns?: BehaviorPatternHit[];
  overtrade?: OvertradeReport | null;
  revenge?: RevengeTradeReport | null;
  winningStreak?: number;       // optional positive reinforcement
}): PersonalRiskAdjustment {
  const limits: RiskLimits = { ...input.baseline };
  const changes: AdjustmentChange[] = [];
  const reasons: string[] = [];

  // ── Revenge trading → drastic cuts ──────────────────────────────────────
  if (input.revenge?.detected) {
    const factor = input.revenge.severity === "CRITICAL" ? 0.3
                 : input.revenge.severity === "HIGH"     ? 0.5
                 :                                          0.7;
    apply(changes, limits, "riskPerTradePct", limits.riskPerTradePct * factor,
          `Revenge trading (${input.revenge.severity}) → risk per trade × ${factor}`);
    apply(changes, limits, "maxTradesPerDay", Math.max(1, Math.floor(limits.maxTradesPerDay * factor)),
          `Revenge trading (${input.revenge.severity}) → max trades/day × ${factor}`);
    reasons.push(...input.revenge.evidence);
  }

  // ── Overtrading → cap remaining trades for the day ──────────────────────
  if (input.overtrade?.detected && input.overtrade.recommendBlock) {
    apply(changes, limits, "maxTradesPerDay", input.overtrade.tradesToday,
          `Overtrading (${input.overtrade.severity}) → freeze max trades at today's count (${input.overtrade.tradesToday})`);
    reasons.push(...input.overtrade.evidence);
  }

  // ── Behavior patterns → targeted dampening ──────────────────────────────
  for (const hit of input.patterns ?? []) {
    if (hit.severity === "NONE" || hit.severity === "LOW") continue;
    const factor = hit.severity === "CRITICAL" ? 0.5
                 : hit.severity === "HIGH"     ? 0.7
                 :                               0.85;
    if (hit.pattern === "OVERSIZED_BETS") {
      apply(changes, limits, "riskPerTradePct", limits.riskPerTradePct * factor,
            `Oversized bets (${hit.severity}) → risk per trade × ${factor}`);
    }
    if (hit.pattern === "FOMO_CHASING") {
      apply(changes, limits, "minConfidenceScore", Math.min(95, limits.minConfidenceScore + 10),
            `FOMO chasing (${hit.severity}) → confidence floor +10`);
    }
    if (hit.pattern === "RUNNER_CUTTING" || hit.pattern === "EARLY_EXIT") {
      // Don't change risk per trade; tighten loss budget so habits cost less.
      apply(changes, limits, "maxDailyLossPct", limits.maxDailyLossPct * 0.85,
            `${hit.pattern} (${hit.severity}) → daily loss cap × 0.85`);
    }
    if (hit.pattern === "FILTER_IGNORING") {
      apply(changes, limits, "maxOpenTrades", Math.max(1, Math.floor(limits.maxOpenTrades * factor)),
            `Filter ignoring (${hit.severity}) → max open trades × ${factor}`);
    }
    reasons.push(...hit.evidence);
  }

  // ── Winning streak → modest, capped reward ──────────────────────────────
  // Never beyond +15% of baseline, and never overrides a reduction already made.
  if (input.winningStreak && input.winningStreak >= 3 && changes.length === 0) {
    const boost = Math.min(1.15, 1 + input.winningStreak * 0.03);
    apply(changes, limits, "riskPerTradePct", input.baseline.riskPerTradePct * boost,
          `Winning streak ${input.winningStreak} → risk per trade × ${boost.toFixed(2)} (capped at 1.15× baseline)`);
  }

  return { adjustedLimits: limits, changes, appliedReasons: reasons };
}

function apply(
  changes: AdjustmentChange[],
  limits: RiskLimits,
  field: keyof RiskLimits,
  proposed: number,
  note: string,
): void {
  const before = limits[field];
  // For risk-reducing rules we only apply if the proposal is more conservative
  // (lower risk %, lower trade caps, higher confidence floor). For the boost
  // rule the caller has already capped at +15% — apply directly.
  const isReduction = note.startsWith("Winning streak") ? false : proposedReduces(field, before, proposed);
  const next = isReduction || note.startsWith("Winning streak") ? round(proposed) : Math.min(before, round(proposed));
  if (next === before) return;
  limits[field] = next;
  changes.push({ field, before, after: next, delta: next - before, note });
}

function proposedReduces(field: keyof RiskLimits, before: number, proposed: number): boolean {
  // For minConfidenceScore, "reducing risk" means *increasing* the floor.
  if (field === "minConfidenceScore") return proposed > before;
  return proposed < before;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

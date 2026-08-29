// ── data/opportunityAdapters.ts ─────────────────────────────────────────────
// Shared adapters that map a ScannerOpportunity (the SINGLE scoring path, from
// scanSymbolTimeframe) onto the two legacy opportunity output shapes Ruby's
// surfaces already consume:
//   - the assistant getMarketScannerOpportunities tool output (T002a)
//   - the per-user opportunityRadar LiveCandidate (T002b)
//
// Keeping these in one place guarantees both surfaces band the opportunity
// label identically (off effectiveOpportunityScore, which folds in advisory /
// governance / timing) and derive take-profit targets identically.
//
// SAFETY: pure mapping. No fabrication — take-profit targets are deterministic
// RR projections off the scanner's own entry + stop, direction-validated, and
// return [] + an honest reason when the setup cannot support them.

import {
  effectiveOpportunityScore,
  type ScannerOpportunity,
  type OpportunityLabel,
} from "../marketScanner.js";
import type { LiveCandidate, TakeProfitTarget } from "../assistant/liveScanner.js";

// ── Banding (exact same thresholds as liveScanner + marketScanner) ──────────

export function deriveOpportunityLabel(score: number): OpportunityLabel {
  const s = Number.isFinite(score) ? score : 0;
  if (s >= 90) return "ELITE";
  if (s >= 80) return "STRONG";
  if (s >= 70) return "ACCEPTABLE";
  if (s >= 60) return "WEAK";
  return "REJECT";
}

// ── Direction + take-profit derivation ──────────────────────────────────────

export type TradeDirection = "BUY" | "SELL";

export function normalizeTradeDirection(action: string): TradeDirection | null {
  const a = String(action ?? "").toUpperCase();
  if (a.includes("BUY") || a.includes("LONG")) return "BUY";
  if (a.includes("SELL") || a.includes("SHORT")) return "SELL";
  return null;
}

function round(n: number, d = 5): number {
  if (!Number.isFinite(n)) return 0;
  const m = 10 ** d;
  return Math.round(n * m) / m;
}

export interface DerivedTakeProfit {
  targets: TakeProfitTarget[];
  bestLabel: "TP1" | "TP2" | "TP3" | null;
  reason: string | null;
  /** Primary (TP2) price when available, else null — backward-compat takeProfit. */
  primaryPrice: number | null;
}

/**
 * Derive TP1/TP2/TP3 from the scanner's own entry + stop using fixed RR
 * multiples (1R / 2R / 3R). The scanner's structure (swing highs/lows, ATR) is
 * not carried on ScannerOpportunity, so targets are pure RR projections,
 * direction-validated against entry. Returns [] + an honest reason when the
 * direction or stop distance is unusable — never invents prices.
 */
export function deriveTakeProfitTargets(
  action: TradeDirection | null,
  entry: number,
  stopLoss: number,
): DerivedTakeProfit {
  if (!action) {
    return {
      targets: [],
      bestLabel: null,
      reason: "No actionable direction — take-profit targets not applicable.",
      primaryPrice: null,
    };
  }
  const stopDist = Math.abs(entry - stopLoss);
  if (!Number.isFinite(entry) || !Number.isFinite(stopDist) || stopDist <= 0) {
    return {
      targets: [],
      bestLabel: null,
      reason: "Insufficient setup data to compute take-profit targets — stop distance unavailable.",
      primaryPrice: null,
    };
  }
  const dir = action === "BUY" ? 1 : -1;
  const mk = (
    mult: number,
    label: TakeProfitTarget["label"],
    suggestedAction: TakeProfitTarget["suggestedAction"],
    confidence: TakeProfitTarget["confidence"],
    reason: string,
  ): TakeProfitTarget => {
    const price = round(entry + dir * stopDist * mult);
    return {
      label,
      price,
      reason,
      rr: mult,
      distancePoints: Math.abs(price - entry),
      distancePips: Math.abs(price - entry) * 10000,
      suggestedAction,
      confidence,
    };
  };
  const all: TakeProfitTarget[] = [
    mk(1, "TP1", "partial", "high", "1R from entry — conservative first target."),
    mk(2, "TP2", "full", "medium", "2R from entry — primary balanced target."),
    mk(3, "TP3", "runner", "low", "3R from entry — extended runner; momentum-dependent."),
  ];
  const targets = all.filter((t) => (action === "BUY" ? t.price > entry : t.price < entry));
  if (targets.length === 0) {
    return {
      targets: [],
      bestLabel: null,
      reason: "Computed targets failed direction validation — refusing to emit.",
      primaryPrice: null,
    };
  }
  const bestLabel: "TP1" | "TP2" | "TP3" = targets.some((t) => t.label === "TP2")
    ? "TP2"
    : targets[0]!.label;
  const primary = targets.find((t) => t.label === bestLabel) ?? null;
  return { targets, bestLabel, reason: null, primaryPrice: primary?.price ?? null };
}

// ── Shared fail-closed setup-level projection (sufficiency-gated) ───────────
// SAFETY (withhold-only): a directional setup (entry / stop / TP1-3 / R:R) may
// be assembled ONLY when the row's SHARED sufficiency verdict permits it
// (`canShowTradeSetup === true`, which is true exactly when status ===
// "sufficient"). A MISSING verdict or ANY non-sufficient verdict WITHHOLDS every
// level and returns an honest withheld state carrying the SAME human-readable
// reason the Ruby Chart Read panel shows. This is the single builder both
// chat/tool surfaces (getMarketScannerOpportunities + scannerOpportunityToLive-
// Candidate → opportunityRadar) route through, so no surface can leak levels
// the chart panel would refuse — including via alternate field names. It is
// display-only: it never grants, sizes, or routes a trade and never feeds an
// execution gate. `canShowTradeSetup` stays the eligibility authority here.

export const SETUP_WITHHELD_SAFE_MESSAGE =
  "A trade setup can't be produced until live chart/feed sufficiency is confirmed for this symbol and timeframe.";

/** The shared verdict's reason-code type, derived so we never re-implement it. */
type SetupSufficiencyReasonCode = NonNullable<ScannerOpportunity["sufficiency"]>["reasonCode"];

export interface ProjectedOpportunitySetup {
  setupWithheld: boolean;
  /** Identical to the chart panel's reason (verdict.humanReason) when withheld. */
  withheldReason: string | null;
  withheldReasonCode: SetupSufficiencyReasonCode | null;
  /** Safe, fixed sentence: a setup can't be produced until sufficiency confirmed. */
  withheldMessage: string | null;
  entry: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  takeProfitTargets: TakeProfitTarget[];
  bestTargetLabel: "TP1" | "TP2" | "TP3" | null;
  targetsUnavailableReason: string | null;
  riskRewardRatio: number | null;
}

/**
 * True iff the shared sufficiency verdict permits SHOWING a directional setup.
 * Fail-closed: a missing verdict is NEVER sufficient.
 */
export function sufficiencyAllowsSetup(o: ScannerOpportunity): boolean {
  return o.sufficiency?.canShowTradeSetup === true;
}

/**
 * Project the sufficiency-gated setup levels for an opportunity. When the shared
 * verdict does not permit a directional setup (or is absent), EVERY level is
 * withheld (null / [] / null) and the withheld reason mirrors the chart panel's
 * humanReason exactly. Otherwise the real entry/stop and deterministic RR
 * take-profit targets are returned. Pure and side-effect-free.
 */
export function projectOpportunitySetup(o: ScannerOpportunity): ProjectedOpportunitySetup {
  if (!sufficiencyAllowsSetup(o)) {
    const reason = o.sufficiency?.humanReason ?? SETUP_WITHHELD_SAFE_MESSAGE;
    return {
      setupWithheld: true,
      withheldReason: reason,
      withheldReasonCode: o.sufficiency?.reasonCode ?? null,
      withheldMessage: SETUP_WITHHELD_SAFE_MESSAGE,
      entry: null,
      stopLoss: null,
      takeProfit: null,
      takeProfitTargets: [],
      bestTargetLabel: null,
      targetsUnavailableReason: reason,
      riskRewardRatio: null,
    };
  }
  const tp = deriveTakeProfitTargets(normalizeTradeDirection(o.recommendedAction), o.entry, o.stopLoss);
  return {
    setupWithheld: false,
    withheldReason: null,
    withheldReasonCode: null,
    withheldMessage: null,
    entry: o.entry,
    stopLoss: o.stopLoss,
    takeProfit: tp.primaryPrice ?? (Number.isFinite(o.takeProfit) ? o.takeProfit : 0),
    takeProfitTargets: tp.targets,
    bestTargetLabel: tp.bestLabel,
    targetsUnavailableReason: tp.reason,
    riskRewardRatio: Number.isFinite(o.riskRewardRatio) ? o.riskRewardRatio : null,
  };
}

// ── dataStatus → coarse dataQuality (radar) ─────────────────────────────────

export type RadarDataQuality = "FRESH" | "STALE" | "UNAVAILABLE";

export function mapScannerDataStatusToDataQuality(
  status: ScannerOpportunity["dataStatus"],
): RadarDataQuality {
  if (status === "live") return "FRESH";
  if (status === "stale") return "STALE";
  return "UNAVAILABLE";
}

// ── ScannerOpportunity → LiveCandidate (radar) ──────────────────────────────

function coerceLiveBias(bias: string): LiveCandidate["bias"] {
  return bias === "bullish" || bias === "bearish" || bias === "neutral" || bias === "choppy"
    ? bias
    : "neutral";
}

function coerceLiveAction(action: string): LiveCandidate["recommendedAction"] {
  const dir = normalizeTradeDirection(action);
  if (dir) return dir;
  const a = String(action ?? "").toUpperCase();
  if (a.includes("REJECT") || a.includes("AVOID")) return "REJECT";
  return "WAIT";
}

function coerceLiveBadge(badge: ScannerOpportunity["statusBadge"]): LiveCandidate["statusBadge"] {
  switch (badge) {
    case "SPREAD_TOO_HIGH":
      return "REJECTED_BY_RISK";
    case "PENDING_MT5_CONNECTION":
      return "WAIT_FOR_CONFIRMATION";
    default:
      return badge;
  }
}

/**
 * Adapt a ScannerOpportunity (single scoring path) into the LiveCandidate shape
 * the opportunityRadar already consumes. The label is banded off
 * effectiveOpportunityScore so advisory/governance/timing adjustments flow
 * through; take-profit targets are derived from entry + stop.
 */
export function scannerOpportunityToLiveCandidate(o: ScannerOpportunity): LiveCandidate {
  const score = effectiveOpportunityScore(o);
  // Sufficiency-gated (withhold-only): when the shared verdict does not permit a
  // setup, every level is withheld. LiveCandidate types entry/stop/tp as plain
  // numbers, so withheld levels become 0 here — the radar coerces `c.entry ||
  // null` / `c.stopLoss || null`, so its keyLevelToWatch / invalidationLevel
  // alternate fields then read null, never a leaked price.
  const setup = projectOpportunitySetup(o);
  return {
    symbol: o.symbol,
    timeframe: o.timeframe,
    bias: coerceLiveBias(o.bias),
    recommendedAction: coerceLiveAction(o.recommendedAction),
    setupType: o.setupType,
    signalStrength: o.signalStrength, // canonical name; equals confidenceScore
    confidenceScore: o.confidenceScore,
    riskScore: o.riskScore,
    riskRewardRatio: setup.riskRewardRatio ?? 0,
    reasonForTrade: o.reasonForTrade,
    reasonToAvoid: o.reasonToAvoid,
    statusBadge: coerceLiveBadge(o.statusBadge),
    opportunityLabel: deriveOpportunityLabel(score),
    entry: setup.entry ?? 0,
    stopLoss: setup.stopLoss ?? 0,
    takeProfit: setup.takeProfit ?? 0,
    takeProfitTargets: setup.takeProfitTargets,
    targetsUnavailableReason: setup.targetsUnavailableReason,
    bestTargetLabel: setup.bestTargetLabel,
    score,
    generatedAt: o.generatedAt,
  };
}

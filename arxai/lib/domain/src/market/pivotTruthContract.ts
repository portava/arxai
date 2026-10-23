// ── PIVOT TRUTH — DISPLAY / DECISION-SUPPORT CONTRACT (Task #652, Phase 2) ─────
//
// SHARED, PURE definition of "where is price relative to the classic pivot grid
// computed from the prior period's high/low/close, what zone/reaction is in play,
// and how may that COLOUR the existing Scanner Truth read?". The caller supplies
// the prior-period OHLC (or pre-computed levels), the current price, and its
// ALREADY-DECIDED feed/sufficiency facts; this contract folds them into one
// `PivotTruthVerdict` that the Scanner, Eleanor, Scalp Builder and Strategy
// evaluation all consume so they can never contradict each other about pivots.
//
// This module is PURE: no IO, no DB, no HTTP, no clock, no role/privilege input.
// Same inputs ⇒ same verdict.
//
// ── SAFETY: PIVOT TRUTH IS A *CHILD INPUT*, DISPLAY-ONLY ─────────────────────
// A pivot location is a LEAN, never permission. Above the pivot is a bullish
// lean, NOT buy permission; below is a bearish lean, NOT sell permission. A pivot
// read may only RAISE-WITHIN-CAP or LOWER what the user SEES — zone wording,
// display confidence (bounded by the caller's caps), reaction labelling, and edge
// score. It may NEVER:
//   • independently produce READY_NOW / "valid now" wording,
//   • override historical-only / feed-limited / unconfirmed-feed status,
//   • override a low-confidence chart read, sufficiency, candle-count or a risk
//     gate,
//   • influence live-execution permission, broker dispatch, the kill switch,
//     owner/admin overrides, or the final trade-execution button.
// The verdict therefore exposes ONLY display hints (`scannerTruthImpact`,
// confidence ceilings, wording). It carries NO execution-permission field.

export type PivotSourceTimeframe = "daily" | "weekly" | "monthly" | "session";

export type PivotBias = "bullish" | "bearish" | "neutral" | "mixed";

export type PivotZone =
  | "above_pivot"
  | "below_pivot"
  | "at_pivot"
  | "at_support"
  | "at_resistance"
  | "between_levels"
  | "breakout_zone"
  | "rejection_zone";

export type PivotReactionStatus =
  | "approaching"
  | "rejecting"
  | "holding"
  | "breaking"
  | "retesting"
  | "failed_break";

export type PivotQuality = "high" | "medium" | "low" | "none";

/** Stable display hint describing how pivots colour the Scanner Truth read. */
export type PivotScannerLabelHint =
  | "none"
  | "context_only" // feed historical/unconfirmed → pivots are context only
  | "above_pivot_lean" // bullish context, not buy permission
  | "below_pivot_lean" // bearish context, not sell permission
  | "decision_zone" // at the pivot — undecided
  | "reaction_zone" // at an R/S level — watch the reaction
  | "rejection_forming" // reaction candle forming at a level
  | "breakout_confirmed" // close beyond an R/S level
  | "failed_break" // a break that reversed (trap)
  | "too_late_chase" // already ran pivot → R2/R3 (or S2/S3)
  | "limited_room" // target sits inside the next pivot level
  | "no_edge" // stuck between levels — wait
  | "supportive"; // confirmed breakout + aligned + live feed → small nudge

export interface PivotPriorPeriod {
  high: number;
  low: number;
  close: number;
}

export interface PivotLevels {
  pivot: number;
  r1: number;
  r2: number;
  r3: number;
  s1: number;
  s2: number;
  s3: number;
}

/** A named level + price, used for the nearest-level read. */
export interface NamedPivotLevel {
  name: "P" | "R1" | "R2" | "R3" | "S1" | "S2" | "S3";
  price: number;
}

/**
 * Measured reaction evidence at the nearest level. The caller derives these from
 * closed candles; this contract NEVER invents them. A break needs a real close
 * beyond the level (not a wick); a rejection needs a real reaction candle.
 */
export interface PivotReactionEvidence {
  /** Price CLOSED beyond the nearest R/S level (never a wick-only poke). */
  closedBeyondLevel: boolean;
  /** Momentum confirmed the move through the level. */
  momentumConfirmed: boolean;
  /** A follow-through candle printed after the break. */
  followThrough: boolean;
  /** A rejection/reversal candle (wick + reversal close) printed at the level. */
  rejectionCandle: boolean;
  /** After a break, price returned to retest the broken level. */
  retest: boolean;
  /** A break that failed and reversed back through the level (trap). */
  failedBreak: boolean;
}

export const EMPTY_PIVOT_REACTION: PivotReactionEvidence = {
  closedBeyondLevel: false,
  momentumConfirmed: false,
  followThrough: false,
  rejectionCandle: false,
  retest: false,
  failedBreak: false,
};

/**
 * The caller's ALREADY-DECIDED display facts. Passed as primitives so this pure
 * contract never imports the sufficiency / feed modules.
 */
export interface PivotDisplayContext {
  feedConfirmed: boolean;
  feedStale: boolean;
  sufficiencyAllowsSetup: boolean;
  chartReadConfidenceLow: boolean;
}

export interface PivotTruthInput {
  pivotSourceTimeframe: PivotSourceTimeframe;
  /** Prior-period OHLC used to compute classic pivots (preferred). */
  prior: PivotPriorPeriod | null;
  /** Pre-computed levels, used only when `prior` is null. */
  precomputedLevels?: PivotLevels | null;
  /** Latest price used to classify the zone (null ⇒ unavailable). */
  currentPrice: number | null;
  /** ATR for proximity classification (null ⇒ fall back to a relative band). */
  atr: number | null;
  reaction: PivotReactionEvidence;
  /** True when price already ran from the pivot out to R2/R3 or S2/S3. */
  exhaustionExtended: boolean;
}

export interface PivotScannerImpact {
  labelHint: PivotScannerLabelHint;
  confidenceCeiling: number;
  qualityCeiling: PivotQuality;
  conditional: boolean;
  contextOnly: boolean;
  /** Bounded edge-score adjustment in [-25, +10]. Positive only when supportive. */
  edgeAdjustment: number;
  supportive: boolean;
}

export interface PivotTruthVerdict {
  pivotSourceTimeframe: PivotSourceTimeframe;
  levels: PivotLevels | null;
  pivot: number | null;
  r1: number | null;
  r2: number | null;
  r3: number | null;
  s1: number | null;
  s2: number | null;
  s3: number | null;
  currentZone: PivotZone;
  nearestLevel: NamedPivotLevel | null;
  distanceToNearestLevel: number | null;
  pivotBias: PivotBias;
  reactionStatus: PivotReactionStatus;
  confidence: number;
  quality: PivotQuality;
  confidenceCapReason: string | null;
  scannerTruthImpact: PivotScannerImpact;
  rubyExplanation: string;
  warnings: string[];
}

const QUALITY_RANK: Record<PivotQuality, number> = { none: 0, low: 1, medium: 2, high: 3 };

function minQuality(a: PivotQuality, b: PivotQuality): PivotQuality {
  return QUALITY_RANK[a] <= QUALITY_RANK[b] ? a : b;
}

function clampConfidence(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

const CONTEXT_ONLY_CONF_CAP = 35;
const EXHAUSTED_CONF_CAP = 40;
const FAILED_BREAK_CONF_CAP = 30;

/**
 * Classic floor-trader pivots from the prior period's high/low/close.
 *   P  = (H + L + C) / 3
 *   R1 = 2P − L      S1 = 2P − H
 *   R2 = P + (H − L) S2 = P − (H − L)
 *   R3 = H + 2(P − L) S3 = L − 2(H − P)
 */
export function computeClassicPivots(prior: PivotPriorPeriod): PivotLevels {
  const { high: h, low: l, close: c } = prior;
  const pivot = (h + l + c) / 3;
  const range = h - l;
  return {
    pivot,
    r1: 2 * pivot - l,
    s1: 2 * pivot - h,
    r2: pivot + range,
    s2: pivot - range,
    r3: h + 2 * (pivot - l),
    s3: l - 2 * (h - pivot),
  };
}

function levelsToNamed(levels: PivotLevels): NamedPivotLevel[] {
  return [
    { name: "S3", price: levels.s3 },
    { name: "S2", price: levels.s2 },
    { name: "S1", price: levels.s1 },
    { name: "P", price: levels.pivot },
    { name: "R1", price: levels.r1 },
    { name: "R2", price: levels.r2 },
    { name: "R3", price: levels.r3 },
  ];
}

function findNearest(named: NamedPivotLevel[], price: number): NamedPivotLevel {
  return [...named].sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price))[0]!;
}

/**
 * Build the ONE shared pivot verdict. `scannerTruthImpact` is downgrade-only with
 * a small bounded supportive nudge gated on a confirmed breakout AND a
 * live-confirmed feed. It can never make the read MORE permissive than the
 * feed/sufficiency already allow.
 */
export function resolvePivotTruth(
  input: PivotTruthInput,
  display: PivotDisplayContext,
): PivotTruthVerdict {
  const warnings: string[] = [];
  const levels = input.prior
    ? computeClassicPivots(input.prior)
    : (input.precomputedLevels ?? null);

  const contextOnly =
    !display.feedConfirmed || display.feedStale || !display.sufficiencyAllowsSetup;

  // Honest empty when pivots cannot be computed or there is no price to locate.
  if (!levels || input.currentPrice == null || !Number.isFinite(input.currentPrice)) {
    warnings.push("Pivot levels unavailable — insufficient prior-period data or no current price.");
    return {
      pivotSourceTimeframe: input.pivotSourceTimeframe,
      levels: levels ?? null,
      pivot: levels?.pivot ?? null,
      r1: levels?.r1 ?? null,
      r2: levels?.r2 ?? null,
      r3: levels?.r3 ?? null,
      s1: levels?.s1 ?? null,
      s2: levels?.s2 ?? null,
      s3: levels?.s3 ?? null,
      currentZone: "between_levels",
      nearestLevel: null,
      distanceToNearestLevel: null,
      pivotBias: "neutral",
      reactionStatus: "approaching",
      confidence: 0,
      quality: "none",
      confidenceCapReason: "Pivot data unavailable.",
      scannerTruthImpact: {
        labelHint: "context_only",
        confidenceCeiling: CONTEXT_ONLY_CONF_CAP,
        qualityCeiling: "none",
        conditional: true,
        contextOnly: true,
        edgeAdjustment: 0,
        supportive: false,
      },
      rubyExplanation: "Pivot levels are unavailable for this symbol/timeframe right now.",
      warnings,
    };
  }

  const price = input.currentPrice;
  const named = levelsToNamed(levels);
  const nearest = findNearest(named, price);
  const distanceToNearestLevel = Math.abs(price - nearest.price);
  const proximityThresh =
    input.atr != null && Number.isFinite(input.atr) && input.atr > 0
      ? 0.25 * input.atr
      : Math.abs(price) * 0.001;
  const atLevel = distanceToNearestLevel <= proximityThresh;

  const r = input.reaction;

  // ── Reaction status — confirmation-gated (close beyond, real reaction candle) ─
  let reactionStatus: PivotReactionStatus;
  if (r.failedBreak) reactionStatus = "failed_break";
  else if (r.retest) reactionStatus = "retesting";
  else if (r.closedBeyondLevel) reactionStatus = "breaking";
  else if (r.rejectionCandle) reactionStatus = "rejecting";
  else if (atLevel) reactionStatus = "holding";
  else reactionStatus = "approaching";

  // ── Zone classification ────────────────────────────────────────────────────
  const aboveP = price > levels.pivot;
  const belowP = price < levels.pivot;
  const nearestIsPivot = nearest.name === "P";
  const nearestIsResistance = nearest.name.startsWith("R");
  const nearestIsSupport = nearest.name.startsWith("S");

  let currentZone: PivotZone;
  if (r.failedBreak) currentZone = "rejection_zone";
  else if (r.closedBeyondLevel && r.momentumConfirmed) currentZone = "breakout_zone";
  else if (r.rejectionCandle && atLevel) currentZone = "rejection_zone";
  else if (atLevel && nearestIsPivot) currentZone = "at_pivot";
  else if (atLevel && nearestIsResistance) currentZone = "at_resistance";
  else if (atLevel && nearestIsSupport) currentZone = "at_support";
  else if (aboveP) currentZone = "above_pivot";
  else if (belowP) currentZone = "below_pivot";
  else currentZone = "between_levels";

  // ── Pivot bias — a LEAN, never permission ──────────────────────────────────
  let pivotBias: PivotBias;
  if (currentZone === "at_pivot") pivotBias = "neutral";
  else if (aboveP) pivotBias = "bullish";
  else if (belowP) pivotBias = "bearish";
  else pivotBias = "neutral";
  // A rejection against the lean side makes it mixed (conflicting evidence).
  if (r.rejectionCandle && aboveP && nearestIsResistance) pivotBias = "mixed";
  if (r.rejectionCandle && belowP && nearestIsSupport) pivotBias = "mixed";

  // ── Confidence (read clarity, NOT permission) ──────────────────────────────
  let confidence = 50;
  if (atLevel) confidence += 8;
  if (reactionStatus === "breaking") confidence += r.momentumConfirmed && r.followThrough ? 18 : 6;
  if (reactionStatus === "rejecting") confidence += 12;
  if (reactionStatus === "retesting") confidence += 10;
  if (reactionStatus === "failed_break") confidence -= 5;
  if (pivotBias === "mixed") confidence -= 10;

  // ── Display caps + label, downgrade-only (highest-precedence cap wins) ──────
  let confidenceCeiling = 100;
  let qualityCeiling: PivotQuality = "high";
  let conditional = false;
  let edgeAdjustment = 0;
  let supportive = false;
  let labelHint: PivotScannerLabelHint = "none";
  let confidenceCapReason: string | null = null;

  if (reactionStatus === "failed_break") {
    labelHint = "failed_break";
    confidenceCeiling = Math.min(confidenceCeiling, FAILED_BREAK_CONF_CAP);
    qualityCeiling = minQuality(qualityCeiling, "low");
    conditional = true;
    edgeAdjustment = -20;
    confidenceCapReason = "Break failed and reversed — treat as a trap, not a breakout.";
    warnings.push(confidenceCapReason);
  } else if (input.exhaustionExtended) {
    labelHint = "too_late_chase";
    confidenceCeiling = Math.min(confidenceCeiling, EXHAUSTED_CONF_CAP);
    qualityCeiling = minQuality(qualityCeiling, "low");
    conditional = true;
    edgeAdjustment = -15;
    confidenceCapReason = "Price already ran from the pivot to an extended level — entering now would chase.";
    warnings.push(confidenceCapReason);
  } else if (currentZone === "breakout_zone" && reactionStatus === "breaking") {
    // A confirmed breakout MAY nudge up — only on a live-confirmed feed, momentum
    // + follow-through, and a usable read. Never produces READY_NOW itself.
    const canSupport =
      !contextOnly &&
      r.momentumConfirmed &&
      r.followThrough &&
      !display.chartReadConfidenceLow &&
      pivotBias !== "mixed";
    if (canSupport) {
      labelHint = "supportive";
      supportive = true;
      edgeAdjustment = 8;
    } else {
      labelHint = "breakout_confirmed";
      conditional = true;
      qualityCeiling = minQuality(qualityCeiling, "medium");
    }
  } else if (currentZone === "rejection_zone" || reactionStatus === "rejecting") {
    labelHint = "rejection_forming";
    conditional = true;
    qualityCeiling = minQuality(qualityCeiling, "medium");
    edgeAdjustment = Math.min(edgeAdjustment, 0);
    confidenceCapReason = "Pivot rejection forming — needs a reaction candle to confirm.";
  } else if (currentZone === "at_pivot") {
    labelHint = "decision_zone";
    conditional = true;
    qualityCeiling = minQuality(qualityCeiling, "medium");
    confidenceCapReason = "Price is at the pivot — a decision zone, wait for a reaction.";
  } else if (currentZone === "at_resistance" || currentZone === "at_support") {
    labelHint = "reaction_zone";
    conditional = true;
    qualityCeiling = minQuality(qualityCeiling, "medium");
  } else if (currentZone === "above_pivot") {
    labelHint = "above_pivot_lean";
    conditional = true;
  } else if (currentZone === "below_pivot") {
    labelHint = "below_pivot_lean";
    conditional = true;
  } else if (currentZone === "between_levels") {
    labelHint = "no_edge";
    conditional = true;
    qualityCeiling = minQuality(qualityCeiling, "low");
    confidenceCapReason = "Price is stuck between pivot levels — no clear edge, wait.";
  }

  // Limited room when the nearest blocking level is within the proximity band on
  // the side price would have to travel through.
  const limitedRoom = atLevel && distanceToNearestLevel <= proximityThresh * 0.5;
  if (limitedRoom && labelHint !== "failed_break" && labelHint !== "too_late_chase") {
    if (labelHint === "supportive" || labelHint === "none") labelHint = "limited_room";
    supportive = false;
    edgeAdjustment = Math.min(edgeAdjustment, 0);
    qualityCeiling = minQuality(qualityCeiling, "medium");
    confidenceCapReason ??= "Target room is limited by the next pivot level.";
  }

  // Feed not live-confirmed → pivots are CONTEXT ONLY. Highest-precedence cap.
  if (contextOnly) {
    labelHint = "context_only";
    confidenceCeiling = Math.min(confidenceCeiling, CONTEXT_ONLY_CONF_CAP);
    qualityCeiling = minQuality(qualityCeiling, "low");
    conditional = true;
    supportive = false;
    edgeAdjustment = Math.min(edgeAdjustment, 0);
    confidenceCapReason = display.feedStale
      ? "Feed is delayed — pivots shown as context only, not live-confirmed."
      : !display.sufficiencyAllowsSetup
        ? "Not enough live data — pivots shown as context only."
        : "Feed not live-confirmed — pivots shown as context only.";
    warnings.push(confidenceCapReason);
  }

  const cappedConfidence = Math.min(clampConfidence(confidence), confidenceCeiling);
  const baseQuality: PivotQuality =
    cappedConfidence >= 70 ? "high" : cappedConfidence >= 50 ? "medium" : cappedConfidence > 0 ? "low" : "none";
  const quality = minQuality(baseQuality, qualityCeiling);

  return {
    pivotSourceTimeframe: input.pivotSourceTimeframe,
    levels,
    pivot: levels.pivot,
    r1: levels.r1,
    r2: levels.r2,
    r3: levels.r3,
    s1: levels.s1,
    s2: levels.s2,
    s3: levels.s3,
    currentZone,
    nearestLevel: nearest,
    distanceToNearestLevel,
    pivotBias,
    reactionStatus,
    confidence: cappedConfidence,
    quality,
    confidenceCapReason,
    scannerTruthImpact: {
      labelHint,
      confidenceCeiling,
      qualityCeiling,
      conditional,
      contextOnly,
      edgeAdjustment,
      supportive,
    },
    rubyExplanation: buildPivotExplanation({
      timeframe: input.pivotSourceTimeframe,
      currentZone,
      pivotBias,
      reactionStatus,
      nearest,
      contextOnly,
      exhaustion: input.exhaustionExtended,
    }),
    warnings: dedupe(warnings),
  };
}

function buildPivotExplanation(args: {
  timeframe: PivotSourceTimeframe;
  currentZone: PivotZone;
  pivotBias: PivotBias;
  reactionStatus: PivotReactionStatus;
  nearest: NamedPivotLevel;
  contextOnly: boolean;
  exhaustion: boolean;
}): string {
  const { timeframe, currentZone, pivotBias, reactionStatus, nearest, contextOnly, exhaustion } = args;
  const parts: string[] = [];
  if (currentZone === "above_pivot") {
    parts.push(`Price is above the ${timeframe} pivot, so bullish pressure has context — but entry still needs confirmation.`);
  } else if (currentZone === "below_pivot") {
    parts.push(`Price is below the ${timeframe} pivot, so bearish pressure has context — but entry still needs confirmation.`);
  } else if (currentZone === "at_pivot") {
    parts.push(`Price is sitting on the ${timeframe} pivot — a decision zone, not a signal.`);
  } else if (currentZone === "at_resistance") {
    parts.push(`Price is approaching ${nearest.name}, so buying here has limited room unless ${nearest.name} breaks cleanly.`);
  } else if (currentZone === "at_support") {
    parts.push(`Price is at ${nearest.name}, a reaction zone — watch how it holds or breaks.`);
  } else if (currentZone === "breakout_zone") {
    parts.push(`Price closed beyond ${nearest.name} — a breakout read, pending follow-through.`);
  } else if (currentZone === "rejection_zone") {
    parts.push(`Price is reacting at ${nearest.name} — a rejection read that supports a conditional fade.`);
  } else {
    parts.push(`Price is between pivot levels (nearest ${nearest.name}) — no clear edge yet.`);
  }
  if (reactionStatus === "failed_break") parts.push("The last break failed, so treat it as a trap.");
  if (exhaustion) parts.push("It already extended toward an outer level, so avoid chasing.");
  if (pivotBias === "mixed") parts.push("The pivot lean and the reaction disagree, so stay conditional.");
  if (contextOnly) parts.push("Feed is not live-confirmed, so treat the pivots as context only.");
  return parts.join(" ");
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs.filter((x) => x && x.trim().length > 0))];
}

// ── UNIFIED PATTERN DETECTION CONTRACT + TAXONOMY (Task #654) ────────────────
//
// The SHARED, PURE taxonomy + classification layer the expanded pattern
// detectors (shooting star, candlestick reversals, consolidation, structure
// breaks) all normalise into. It sits ALONGSIDE `patternTruthContract.ts`
// (which folds raw `DetectedPattern[]` into the Scanner Truth display verdict):
// this module adds the richer family / asset-class / direction / trade-read
// taxonomy that lets Eleanor NAME and CLASSIFY a structure, plus the pure
// `classifyTradeRead` reducer that turns "what structure is present" into "what
// kind of read this is" (buy / sell / scalp / reversal / continuation /
// consolidation / no-trade).
//
// This module is PURE: no IO, no DB, no HTTP, no clock, no role/privilege input.
// Same inputs ⇒ same verdict.
//
// ── SAFETY: PATTERNS ARE EVIDENCE, NOT PERMISSION ───────────────────────────
// A pattern (and the trade-read it classifies into) may only EXPLAIN, WARN,
// CONFIRM, INVALIDATE, DOWNGRADE, and CLASSIFY market phase. It may NEVER:
//   • independently produce READY_NOW / "ready now" / "valid now" wording,
//   • override a stale / historical / feed-limited feed state,
//   • override candle sufficiency, Trade-Health eligibility, or a risk gate,
//   • influence live-execution permission, broker dispatch, the kill switch,
//     owner/admin overrides, or the final trade-execution button.
// Every type in this module is DISPLAY / DECISION-SUPPORT only and carries NO
// execution-permission field. An "actionable" trade-read (buy/sell/scalp) is a
// CLASSIFICATION of the structure's quality, NOT a grant: the caller ALWAYS ANDs
// it with the real feed / sufficiency / Trade-Health / risk state, which keep
// final say. The import-boundary CI guard fences this module out of every
// execution/safety surface.

import type {
  PatternBias,
  PatternCategory,
  PatternQuality,
  PatternRiskBand,
  PatternStatus,
} from "./patternTruthContract";

/** The seven structural families a detected pattern can belong to. */
export type PatternFamily =
  | "reversal"
  | "continuation"
  | "consolidation"
  | "candlestick"
  | "structure"
  | "scalp"
  | "no_trade";

/**
 * The asset class a symbol belongs to. Per-class behaviour (volatility, session,
 * spread, news sensitivity, ATR sizing, reliability bucketing) differs — see
 * `assetPatternProfile.ts`. Synthetic reliability stats are ALWAYS kept separate
 * from forex/gold/indices.
 */
export type PatternAssetClass =
  | "forex"
  | "gold"
  | "indices"
  | "synthetic"
  | "metals"
  | "crypto"
  | "generic";

/** Direction a pattern leans, expressed in trader terms. */
export type PatternDirection = "buy" | "sell" | "neutral";

/**
 * The classified kind of read a structure produces.
 *   buy / sell / scalp     → ACTIONABLE (a structure clean enough to describe a
 *                            directional/scalp idea) — still NOT an execution
 *                            grant; the caller ANDs it with the real gates.
 *   reversal / continuation/ consolidation
 *                          → DESCRIPTIVE (a structure is present but the read is
 *                            not actionable yet — forming, context-only, or
 *                            ranging).
 *   no_trade               → nothing actionable / explicitly suppressed.
 */
export type TradeReadClass =
  | "buy"
  | "sell"
  | "scalp"
  | "reversal"
  | "continuation"
  | "consolidation"
  | "no_trade";

/** Where in the structure price sits — colours quality, never grants entry. */
export type PatternLocationQuality =
  | "at_support"
  | "at_resistance"
  | "premium"
  | "discount"
  | "equilibrium"
  | "mid_range"
  | "unknown";

/** Target-room band: how much room to the nearest blocking level. */
export type PatternTargetRoom = "ample" | "medium" | "limited" | "unknown";

/**
 * The unified, display-only record a detector emits. A SUPERSET of the raw
 * `DetectedPattern` with the taxonomy fields, an honest (non-guaranteed)
 * reliability note, and the research-source ids that SEED the detector. It
 * carries NO execution-permission field by construction.
 */
export interface PatternDetection {
  /** Stable machine key (matches a `patternLibrary` id where catalogued). */
  id: string;
  /** Human label. */
  name: string;
  family: PatternFamily;
  assetClass: PatternAssetClass;
  direction: PatternDirection;
  status: PatternStatus;
  /** Raw geometric confidence 0–100 BEFORE any display cap. */
  confidence: number;
  quality: PatternQuality;
  locationQuality: PatternLocationQuality;
  confirmationLevel: number | null;
  invalidationLevel: number | null;
  targets: number[];
  targetRoom: PatternTargetRoom;
  /** Closed candles the detector actually used. */
  candlesUsed: number;
  /** Minimum closed candles the pattern needs to be detectable. */
  minCandles: number;
  /** Measurable conditions that were satisfied (for explanation + audit). */
  rationale: string[];
  /** Known ways this pattern fails — surfaced as honest warnings, never hidden. */
  failureModes: string[];
  /**
   * Honest, NON-GUARANTEED reliability note (e.g. "internal stats withheld until
   * enough resolved samples"). Never a profitability promise.
   */
  reliabilityNote: string;
  /** Research-source ids that informed this detector (claims, not guarantees). */
  researchRefs: string[];
  warnings: string[];
  /** True when the feed is not live-confirmed → the pattern is context only. */
  contextOnly: boolean;
  /** True when the detector honoured the caller's feed-staleness facts. */
  freshnessRespected: boolean;
}

/** A buy/sell/scalp read is actionable; the rest are descriptive. */
export function isActionableTradeRead(read: TradeReadClass): boolean {
  return read === "buy" || read === "sell" || read === "scalp";
}

/** Map a raw `PatternBias` to a trader-facing direction. */
export function biasToDirection(bias: PatternBias): PatternDirection {
  return bias === "bullish" ? "buy" : bias === "bearish" ? "sell" : "neutral";
}

/** Map the raw `DetectedPattern` category to a unified family. */
export function categoryToFamily(category: PatternCategory): PatternFamily {
  switch (category) {
    case "reversal":
      return "reversal";
    case "continuation":
      return "continuation";
    case "breakout_retest":
      return "continuation";
    case "candlestick":
      return "candlestick";
    case "structure":
      return "structure";
    case "scalp_flare":
      return "scalp";
    default:
      return "no_trade";
  }
}

/**
 * The caller's ALREADY-DECIDED display facts (primitives, like
 * `PatternDisplayContext`) plus the structure summary. Passed in so this pure
 * reducer never recomputes feed / sufficiency / timing / spread — it only
 * CLASSIFIES given them.
 */
export interface ClassifyTradeReadInput {
  family: PatternFamily;
  direction: PatternDirection;
  status: PatternStatus;
  /** Feed genuinely live-confirmed (LIVE + FULL read). */
  feedConfirmed: boolean;
  /** Feed delayed/stale (read uses last closed bars only). */
  feedStale: boolean;
  /** Sufficiency already allows showing a trade setup. */
  sufficiencyAllowsSetup: boolean;
  /** Scalp timing already judged acceptable by the caller (session/clock). */
  scalpTimingOk: boolean;
  /** Spread already judged acceptable by the caller. */
  spreadAcceptable: boolean;
}

/**
 * The classified read. DISPLAY-ONLY: it describes WHAT KIND of structure this is
 * and whether it is actionable — it is NEVER an execution permission and carries
 * no ready / execute / dispatch field.
 */
export interface TradeReadVerdict {
  tradeRead: TradeReadClass;
  /** True when the read is conditional ("if X then"), not a clean live read. */
  conditional: boolean;
  /** True when the feed is not live-confirmed → context only. */
  contextOnly: boolean;
  reasons: string[];
}

/** The descriptive (non-actionable) read for a family. */
function descriptiveFor(family: PatternFamily): TradeReadClass {
  switch (family) {
    case "consolidation":
      return "consolidation";
    case "continuation":
      return "continuation";
    case "reversal":
    case "candlestick":
    case "structure":
      return "reversal";
    case "scalp":
    case "no_trade":
    default:
      return "no_trade";
  }
}

/**
 * Reduce a structure summary + the caller's display facts into a classified
 * trade-read. The CORE SAFETY RULE lives here:
 *   • Consolidation is ALWAYS descriptive (never buy/sell) — a range is a
 *     no-edge zone, so it can only suppress an aggressive read.
 *   • A scalp read requires confirmation AND a live feed AND acceptable timing
 *     AND acceptable spread — otherwise it collapses to no_trade.
 *   • A directional buy/sell read requires a CONFIRMED status AND a live feed
 *     AND a non-neutral direction. Anything less stays descriptive/conditional.
 *   • A non-live / stale / insufficient feed (contextOnly) can NEVER yield an
 *     actionable read — the pattern cannot override the feed truth. No amount of
 *     historical reliability changes this, because reliability is not an input.
 */
export function classifyTradeRead(input: ClassifyTradeReadInput): TradeReadVerdict {
  const reasons: string[] = [];
  const contextOnly =
    !input.feedConfirmed || input.feedStale || !input.sufficiencyAllowsSetup;

  if (input.family === "no_trade" || input.status === "none") {
    return { tradeRead: "no_trade", conditional: false, contextOnly, reasons };
  }

  // Consolidation is never actionable — it describes a no-edge range.
  if (input.family === "consolidation") {
    reasons.push("Price is consolidating — a range, not a directional edge.");
    return { tradeRead: "consolidation", conditional: true, contextOnly, reasons };
  }

  // Failed/invalidated/exhausted structures are never an actionable read.
  if (
    input.status === "failed" ||
    input.status === "invalidated" ||
    input.status === "exhausted"
  ) {
    reasons.push(
      input.status === "exhausted"
        ? "Structure is late/exhausted — entering now would be a chase."
        : "Structure failed/invalidated — no actionable read.",
    );
    return {
      tradeRead: descriptiveFor(input.family),
      conditional: true,
      contextOnly,
      reasons,
    };
  }

  // Not live-confirmed → the pattern is context only and can never be actionable.
  if (contextOnly) {
    reasons.push(
      input.feedStale
        ? "Feed is delayed — structure shown as context only, not a live read."
        : !input.sufficiencyAllowsSetup
          ? "Not enough live data — structure shown as context only."
          : "Feed not live-confirmed — structure shown as context only.",
    );
    return {
      tradeRead: descriptiveFor(input.family),
      conditional: true,
      contextOnly: true,
      reasons,
    };
  }

  // Forming structures are descriptive + conditional (waiting for the trigger).
  if (input.status === "forming") {
    reasons.push("Structure is forming, not confirmed — waiting for the trigger.");
    return {
      tradeRead: descriptiveFor(input.family),
      conditional: true,
      contextOnly: false,
      reasons,
    };
  }

  // status === "confirmed" on a live-confirmed feed.
  if (input.family === "scalp") {
    if (input.scalpTimingOk && input.spreadAcceptable) {
      return { tradeRead: "scalp", conditional: false, contextOnly: false, reasons };
    }
    reasons.push(
      !input.scalpTimingOk
        ? "Scalp timing is not clean (session/clock) — no scalp read."
        : "Spread is too wide for a scalp — no scalp read.",
    );
    return { tradeRead: "no_trade", conditional: true, contextOnly: false, reasons };
  }

  if (input.direction === "buy" || input.direction === "sell") {
    return {
      tradeRead: input.direction,
      conditional: false,
      contextOnly: false,
      reasons,
    };
  }

  // Confirmed but neutral direction → descriptive.
  reasons.push("Structure confirmed but direction is neutral.");
  return {
    tradeRead: descriptiveFor(input.family),
    conditional: true,
    contextOnly: false,
    reasons,
  };
}

/** Re-export the shared bands so detectors import one taxonomy module. */
export type { PatternQuality, PatternRiskBand, PatternStatus, PatternBias };

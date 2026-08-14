// Task #512 — One Truth, One Brain (pure domain contract).
//
// These are the PURE, deterministic types consumed and produced by
// `composeVerdict` / `evaluateLevelStaleness`. They contain NO I/O, NO clock
// reads, and NO provider/enum strings that leak into user-facing copy — every
// display string is built here as clean English so each surface renders the
// SAME words. The api-server brain (`symbolTruthSnapshot.ts`) normalizes the
// real resolver outputs into these shapes and calls the pure composer.
//
// SAFETY: read-side only. Nothing here gates, slows, or places a trade. Unknown
// stays unknown — a missing/blind component is `present:false`, never guessed.

/** Confirmed live, warming up, gone stale, or no usable data at all. */
export type TruthDataState =
  | "LIVE_CONFIRMED"
  | "SYNCING"
  | "STALE"
  | "UNAVAILABLE";

/** A single component's directional read. UNKNOWN when blind/absent. */
export type TruthAlignment = "BULLISH" | "BEARISH" | "NEUTRAL" | "UNKNOWN";

/** The composed market bias across present components. */
export type TruthBias =
  | "BULLISH"
  | "BEARISH"
  | "NEUTRAL"
  | "CONFLICT"
  | "UNKNOWN";

/** Structural state of the composed read. */
export type TruthStage =
  | "ALIGNED"
  | "DEVELOPING"
  | "CONFLICT"
  | "UNKNOWN";

/** The single recommended posture. Read-only advice — never an execution gate. */
export type TruthBestAction =
  | "BUY"
  | "SELL"
  | "WAIT_FOR_DATA"
  | "WAIT_FOR_NEWS"
  | "STAND_ASIDE"
  | "WATCH_ONLY";

/** The four composed components, in display order. */
export type TruthComponentKey = "scanner" | "flame" | "timing" | "scalp";

/**
 * One normalized component verdict. `present` is false whenever the underlying
 * resolver was blind, errored, or had insufficient data — such a component
 * contributes NOTHING to the vote and is never cited as evidence.
 */
export interface TruthComponentInput {
  key: TruthComponentKey;
  present: boolean;
  alignment: TruthAlignment;
  /** Clean-English one-liner shown verbatim by every surface. */
  label: string;
  /** ISO timestamp of when THIS component's read was generated (data time). */
  asOf: string | null;
}

/** Actionable price geometry, BEFORE the stale-level guard runs. */
export interface TruthLevelInput {
  entryFrom: number | null;
  entryTo: number | null;
  stopLoss: number | null;
  invalidation: number | null;
  takeProfit: number[];
}

export interface ComposeVerdictInput {
  dataState: TruthDataState;
  /** Last confirmed price (close of newest closed bar), or null. */
  price: number | null;
  /** True only when a connected calendar reports a high-impact window now. */
  highImpactWindowActive: boolean;
  components: TruthComponentInput[];
  levels: TruthLevelInput;
  /** Average true range in price units, when known — tightens the stale guard. */
  atr?: number | null;
}

export interface LevelStalenessInput {
  price: number | null;
  levels: TruthLevelInput;
  atr?: number | null;
}

export interface LevelStalenessResult {
  stale: boolean;
  /** Clean-English reason when stale, else null. */
  reason: string | null;
}

export type TruthInvalidationSide = "ABOVE" | "BELOW";

export interface TruthInvalidation {
  price: number;
  side: TruthInvalidationSide;
}

/** Levels as exposed to surfaces — withheld (all null) when the guard trips. */
export interface ComposedLevels {
  entryFrom: number | null;
  entryTo: number | null;
  stopLoss: number | null;
  invalidation: number | null;
  takeProfit: number[];
  withheld: boolean;
  /** Clean-English reason when withheld, else null. */
  withheldReason: string | null;
}

export interface ComposedVerdict {
  stage: TruthStage;
  bias: TruthBias;
  /** Clean-English headline summarizing the read. */
  headline: string;
  /** Clean-English sentences — ONLY for present components aligned with the read. */
  evidenceFor: string[];
  /** Clean-English sentences — present components opposing the read. */
  evidenceAgainst: string[];
  bestAction: TruthBestAction;
  /** Clean-English rendering of `bestAction`. */
  bestActionText: string;
  invalidation: TruthInvalidation | null;
  levels: ComposedLevels;
}

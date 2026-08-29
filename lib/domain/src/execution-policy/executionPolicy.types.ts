// Capability #27 — Execution Policy Intelligence (SHADOW-ONLY).
//
// A policy CHOOSER over the certified execution shapes that exist today. It
// RECOMMENDS and journals; it never places, modifies, stages, or cancels
// anything. The actual order path stays exactly as-is — the recommendation
// rides as advisory evidence next to the dispatch record.
//
// SAFETY CONTRACT
// ---------------
// - The only two members of `ExecutionShape` are the two shapes the system
//   has actually certified: the immediate market dispatch (EA-bridge market
//   order / Deriv multiplier buy) and the Phase 6 guided staged path
//   (proposal → confirm over the certified Phase 5 primitives). This module
//   must NEVER grow a shape the venue has not certified — a recommendation
//   for an uncertified shape would be an invented execution path.
// - Every recommendation is stamped `shadow: true` + `advisoryOnly: true`.
// - Missing evidence degrades to the venue's existing default shape with an
//   honest reason — never to a synthesized preference.

/** The certified execution shapes that exist today. Closed set — see above. */
export const EXECUTION_SHAPES = ["IMMEDIATE_MARKET", "GUIDED_STAGED"] as const;
export type ExecutionShape = (typeof EXECUTION_SHAPES)[number];

/** How urgent the caller says the entry is. */
export const URGENCY_CLASSES = ["IMMEDIATE", "NORMAL", "PATIENT"] as const;
export type UrgencyClass = (typeof URGENCY_CLASSES)[number];

/** Spread state at decision time. Units: price units of the instrument. */
export interface SpreadState {
  /** Current ask - bid. Null = unreadable (degrades honestly). */
  currentSpread: number | null;
  /** Recent typical spread for the same instrument (e.g. session median).
   *  Null = no baseline yet. */
  typicalSpread: number | null;
}

/** Order size relative to what the market has recently absorbed. */
export interface SizeContext {
  /** Requested size, venue units (lots / stake). */
  orderSize: number;
  /** Recent per-interval traded volume in the same units, or null when the
   *  venue exposes no usable volume (degrades honestly). */
  recentVolume: number | null;
}

// ── Fill-quality evidence ────────────────────────────────────────────────────

/** One normalized fill observation from the EXISTING demo fill records. */
export interface FillRecord {
  shape: ExecutionShape;
  side: "BUY" | "SELL";
  /** Price the command asked for. */
  requestedPrice: number;
  /** Price the venue reported filling at. */
  filledPrice: number;
  /** Queue-to-fill latency in ms (approximate on the demo path: row create →
   *  broker-result write-back). Null = not measurable for this record. */
  latencyMs: number | null;
}

/** Aggregated fill-quality evidence for one shape. */
export interface FillQualityStats {
  shape: ExecutionShape;
  sampleSize: number;
  /** Mean signed adverse slippage in price units (positive = worse than
   *  requested: paid more on BUY, received less on SELL). */
  meanAdverseSlippage: number;
  /** Median of the same. */
  medianAdverseSlippage: number;
  /** Worst observed adverse slippage. */
  maxAdverseSlippage: number;
  /** Median latency over records that carried one; null when none did. */
  medianLatencyMs: number | null;
  latencySampleSize: number;
}

/** Honest-null wrapper: either stats or the reason there are none. */
export type FillQualityEvidence =
  | { available: true; stats: FillQualityStats }
  | { available: false; shape: ExecutionShape; reason: string };

// ── Chooser I/O ──────────────────────────────────────────────────────────────

export interface ExecutionPolicyInput {
  spread: SpreadState;
  urgency: UrgencyClass;
  size: SizeContext;
  /** Evidence per shape, from the fill-quality store. */
  fillQuality: FillQualityEvidence[];
  /** The shape the venue's existing (unchanged) order path will use anyway.
   *  This is what a data-starved recommendation degrades to. */
  currentDefaultShape: ExecutionShape;
}

export interface ExecutionPolicyRecommendation {
  recommendedShape: ExecutionShape;
  /** True when the recommendation differs from the path the system will
   *  actually take (`currentDefaultShape`) — the interesting journal signal. */
  divergesFromDefault: boolean;
  /** 0..1 — how much evidence backs the recommendation. Low confidence means
   *  "we mostly fell back to the default", never invented certainty. */
  confidence: number;
  rationale: string[];
  /** Inputs echoed for the journal — the recommendation must be replayable. */
  evidence: {
    spread: SpreadState;
    urgency: UrgencyClass;
    size: SizeContext;
    fillQuality: FillQualityEvidence[];
    currentDefaultShape: ExecutionShape;
  };
  /** Hard-stamped: shadow mode, advisory evidence, never an order. */
  shadow: true;
  advisoryOnly: true;
}

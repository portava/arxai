// ── TRENDLINE LIBRARY — PHASE-1 INVENTORY (Task #649) ────────────────────────
//
// The SINGLE in-repo, typed inventory of every trendline geometry the Trendline
// Truth engine is built to recognise, plus the catalogue of every trendline
// change-event and pattern-change id a detector may emit. It is the SPEC the
// geometry detector (`trendlineEngine.ts`) implements against: for every
// `ActiveTrendline.id` the detector can emit there is exactly one entry here,
// describing how the line is detected, what confirms/invalidates it, how its
// target is measured, its known failure modes, and the context filters that raise
// or lower its reliability.
//
// PURE DATA + TYPES ONLY. This module imports nothing but the display-side
// trendline enums from the contract in this same package. It has NO IO, NO DB, NO
// clock, and — like the rest of the Trendline Truth layer — it is DISPLAY /
// DECISION-SUPPORT only: it can never be read by an execution/safety surface and
// it grants no trade affordance. It exists so the catalogue lives in
// version-controlled, type-checked code rather than only in a task document, and
// so a test can cross-check the detector's coverage against the inventory.

import type {
  TrendlineBias,
  TrendlineCategory,
  TrendlineChangeKind,
  TrendlineRiskBand,
  PatternChangeKind,
} from "./trendlineTruthContract";

/** A trendline can be one-directional or print in both directions. */
export type TrendlineLibraryBias = TrendlineBias | "both";

/** One catalogued trendline geometry — the detection spec for a single id. */
export interface TrendlineLibraryEntry {
  /** Stable machine key — MUST match the `ActiveTrendline.id` the detector emits. */
  id: string;
  /** Human label. */
  name: string;
  category: TrendlineCategory;
  bias: TrendlineLibraryBias;
  /** Minimum closed candles the detector needs before it can emit this line. */
  minCandles: number;
  /** Minimum swing touches that DEFINE the line (≥2; a 3rd raises quality). */
  minTouches: number;
  /** Measurable geometry/conditions that DEFINE the line. */
  detection: string[];
  /** The trigger that turns a forming line into a confirmed one. */
  confirmation: string;
  /** The structural event that invalidates / breaks the line. */
  invalidation: string;
  /** How the measured-move / projected target is derived. */
  target: string;
  /** Known ways the line read fails — surfaced as honest warnings, never hidden. */
  failureModes: string[];
  /** Context that RAISES or LOWERS reliability (never an execution gate). */
  contextFilters: string[];
  /** Typical false-break risk band for the line in isolation. */
  falseBreakoutRisk: TrendlineRiskBand;
}

// ── Group 1 · Trend support / resistance (diagonal) ──────────────────────────
const TREND_LINES: TrendlineLibraryEntry[] = [
  {
    id: "ascending_support",
    name: "Ascending Support",
    category: "trend_support",
    bias: "bullish",
    minCandles: 20,
    minTouches: 2,
    detection: [
      "A rising line fit across two or more swing lows (higher lows).",
      "Price holds ABOVE the line; touches respect it within an ATR-normalized tolerance.",
    ],
    confirmation: "A third touch that holds, or a close that bounces from the line.",
    invalidation: "A decisive close BELOW the line (break) by an ATR-normalized distance.",
    target: "The prior swing high, or the channel top when a parallel line exists.",
    failureModes: [
      "A close below the line breaks the uptrend support (possible trend shift).",
      "Only two touches leave the line unconfirmed (forming).",
    ],
    contextFilters: [
      "Three or more touches raise reliability.",
      "Aligned with the higher-timeframe up-trend strengthens the read.",
    ],
    falseBreakoutRisk: "medium",
  },
  {
    id: "descending_resistance",
    name: "Descending Resistance",
    category: "trend_resistance",
    bias: "bearish",
    minCandles: 20,
    minTouches: 2,
    detection: [
      "A falling line fit across two or more swing highs (lower highs).",
      "Price holds BELOW the line; touches respect it within an ATR-normalized tolerance.",
    ],
    confirmation: "A third touch that rejects, or a close that fades from the line.",
    invalidation: "A decisive close ABOVE the line (break) by an ATR-normalized distance.",
    target: "The prior swing low, or the channel bottom when a parallel line exists.",
    failureModes: [
      "A close above the line breaks the downtrend resistance (possible trend shift).",
      "Only two touches leave the line unconfirmed (forming).",
    ],
    contextFilters: [
      "Three or more touches raise reliability.",
      "Aligned with the higher-timeframe down-trend strengthens the read.",
    ],
    falseBreakoutRisk: "medium",
  },
];

// ── Group 2 · Channels (parallel) ────────────────────────────────────────────
const CHANNELS: TrendlineLibraryEntry[] = [
  {
    id: "ascending_channel",
    name: "Ascending Channel",
    category: "channel",
    bias: "bullish",
    minCandles: 24,
    minTouches: 3,
    detection: [
      "A rising support line and a roughly parallel rising resistance line.",
      "Price oscillates between the two with matching slopes.",
    ],
    confirmation: "Touches on BOTH rails confirm the channel.",
    invalidation: "A decisive close beyond either rail by an ATR-normalized distance.",
    target: "The opposite rail (mean-reversion) or the channel height projected on a break.",
    failureModes: [
      "A close above the top rail can be exhaustion, not continuation.",
      "A close below the bottom rail breaks the channel (trend shift risk).",
    ],
    contextFilters: [
      "Clean alternating touches on both rails raise reliability.",
      "A widening channel is less reliable than a tight, parallel one.",
    ],
    falseBreakoutRisk: "medium",
  },
  {
    id: "descending_channel",
    name: "Descending Channel",
    category: "channel",
    bias: "bearish",
    minCandles: 24,
    minTouches: 3,
    detection: [
      "A falling resistance line and a roughly parallel falling support line.",
      "Price oscillates between the two with matching slopes.",
    ],
    confirmation: "Touches on BOTH rails confirm the channel.",
    invalidation: "A decisive close beyond either rail by an ATR-normalized distance.",
    target: "The opposite rail (mean-reversion) or the channel height projected on a break.",
    failureModes: [
      "A close below the bottom rail can be exhaustion, not continuation.",
      "A close above the top rail breaks the channel (trend shift risk).",
    ],
    contextFilters: [
      "Clean alternating touches on both rails raise reliability.",
      "A widening channel is less reliable than a tight, parallel one.",
    ],
    falseBreakoutRisk: "medium",
  },
];

// ── Group 3 · Horizontal range edges ─────────────────────────────────────────
const HORIZONTAL: TrendlineLibraryEntry[] = [
  {
    id: "horizontal_support",
    name: "Horizontal Support",
    category: "horizontal",
    bias: "bullish",
    minCandles: 20,
    minTouches: 2,
    detection: [
      "A flat (near-zero slope) line across two or more swing lows at a similar level.",
      "Price holds above the level on each test.",
    ],
    confirmation: "A bounce that holds the level, or a third test that respects it.",
    invalidation: "A decisive close below the level (breakdown).",
    target: "The range high, or the measured range height on a breakout.",
    failureModes: [
      "A close below the level is a breakdown (range becomes resistance).",
      "A thin, untested level is low reliability.",
    ],
    contextFilters: [
      "More tests of the level raise reliability.",
      "A level that also aligns with a round number / prior structure is stronger.",
    ],
    falseBreakoutRisk: "high",
  },
  {
    id: "horizontal_resistance",
    name: "Horizontal Resistance",
    category: "horizontal",
    bias: "bearish",
    minCandles: 20,
    minTouches: 2,
    detection: [
      "A flat (near-zero slope) line across two or more swing highs at a similar level.",
      "Price holds below the level on each test.",
    ],
    confirmation: "A rejection that holds the level, or a third test that respects it.",
    invalidation: "A decisive close above the level (breakout).",
    target: "The range low, or the measured range height on a breakdown.",
    failureModes: [
      "A close above the level is a breakout (range becomes support).",
      "A thin, untested level is low reliability.",
    ],
    contextFilters: [
      "More tests of the level raise reliability.",
      "A level that also aligns with a round number / prior structure is stronger.",
    ],
    falseBreakoutRisk: "high",
  },
];

/** The complete trendline geometry inventory across all categories. */
export const TRENDLINE_LIBRARY: readonly TrendlineLibraryEntry[] = [
  ...TREND_LINES,
  ...CHANNELS,
  ...HORIZONTAL,
];

/** Every trendline category the inventory covers. */
export const TRENDLINE_LIBRARY_CATEGORIES: readonly TrendlineCategory[] = [
  "trend_support",
  "trend_resistance",
  "channel",
  "horizontal",
];

/** One catalogued trendline change-event or pattern-change kind. */
export interface TrendlineChangeCatalogEntry {
  kind: TrendlineChangeKind;
  name: string;
  description: string;
}

export interface PatternChangeCatalogEntry {
  kind: PatternChangeKind;
  name: string;
  description: string;
}

/** Every trendline change-event a detector may emit on the dominant line. */
export const TRENDLINE_CHANGE_CATALOG: readonly TrendlineChangeCatalogEntry[] = [
  { kind: "none", name: "No change", description: "No discrete event on the line." },
  {
    kind: "break",
    name: "Break",
    description: "A decisive close beyond the line by an ATR-normalized distance (never wick-only).",
  },
  {
    kind: "retest",
    name: "Retest",
    description: "After a break, price returned to the broken line from the new side.",
  },
  {
    kind: "reclaim",
    name: "Reclaim",
    description: "After a break, price closed back on the original side — the break did not hold.",
  },
  {
    kind: "failure",
    name: "Failure",
    description: "A break that reversed immediately (trap / false break).",
  },
  {
    kind: "acceleration",
    name: "Acceleration",
    description: "The line's slope is steepening — momentum is building.",
  },
  {
    kind: "flattening",
    name: "Flattening",
    description: "The line's slope is decaying toward zero — the trend is losing energy.",
  },
];

/** Every higher-order pattern/trend change a detector may emit. */
export const PATTERN_CHANGE_CATALOG: readonly PatternChangeCatalogEntry[] = [
  { kind: "none", name: "No change", description: "No structural transition." },
  { kind: "confirmation", name: "Confirmation", description: "A forming structure just confirmed." },
  { kind: "invalidation", name: "Invalidation", description: "A structure's invalidation level was violated." },
  { kind: "failure", name: "Failure", description: "A confirmed breakout turned into a trap." },
  { kind: "transition", name: "Transition", description: "One structure is morphing into another." },
  { kind: "exhaustion", name: "Exhaustion", description: "A confirmed move is over-extended / late." },
  {
    kind: "reversal_warning",
    name: "Reversal warning",
    description: "Early evidence the prevailing trend may reverse.",
  },
  {
    kind: "trend_shift_bullish",
    name: "Bullish trend shift",
    description: "Resistance break plus higher lows — the trend is shifting up.",
  },
  {
    kind: "trend_shift_bearish",
    name: "Bearish trend shift",
    description: "Support break plus lower highs — the trend is shifting down.",
  },
  { kind: "trend_to_range", name: "Trend → range", description: "A trend flattened into a range." },
  { kind: "range_to_trend", name: "Range → trend", description: "A range broke into a trend." },
];

/** Look up a single catalogued trendline by its stable id. */
export function trendlineLibraryEntry(id: string): TrendlineLibraryEntry | null {
  return TRENDLINE_LIBRARY.find((e) => e.id === id) ?? null;
}

/** All catalogued trendlines in one category. */
export function trendlineLibraryByCategory(
  category: TrendlineCategory,
): TrendlineLibraryEntry[] {
  return TRENDLINE_LIBRARY.filter((e) => e.category === category);
}

/** The set of every catalogued trendline id (for detector cross-checks). */
export function trendlineLibraryIds(): Set<string> {
  return new Set(TRENDLINE_LIBRARY.map((e) => e.id));
}

/** The set of every trendline change-event kind. */
export function trendlineChangeKinds(): Set<TrendlineChangeKind> {
  return new Set(TRENDLINE_CHANGE_CATALOG.map((e) => e.kind));
}

/** The set of every pattern-change kind. */
export function patternChangeKinds(): Set<PatternChangeKind> {
  return new Set(PATTERN_CHANGE_CATALOG.map((e) => e.kind));
}

// ── PATTERN RESEARCH SOURCES (Task #654) ────────────────────────────────────
//
// A small, PURE, curated registry of the established technical-analysis
// literature that DEFINES the patterns this library detects. Each source records
// the structural CLAIMS it makes about a pattern (what the geometry is, what it
// is said to signal, how it confirms/invalidates) — NOT a profitability promise.
//
// ── HONESTY CONTRACT ────────────────────────────────────────────────────────
// A research claim is a DEFINITION / HYPOTHESIS, never evidence of edge. The
// ONLY source of truth for whether a pattern actually works in ARX is the
// internal backtest / forward-test reliability record (see `patternReliability`).
// Therefore a source's `claims` must never assert a win rate, profit, guaranteed
// outcome, or "high probability of success". A CI/unit test scans this file for
// such language. These sources SEED detectors (so Eleanor can cite WHY a shape
// matters) and are referenced by id from `PatternDetection.researchRefs`.

/** What kind of structures a source primarily documents. */
export type PatternResearchCategory =
  | "candlestick"
  | "chart_pattern"
  | "price_action"
  | "market_structure"
  | "education";

export interface PatternResearchSource {
  /** Stable id referenced from `PatternDetection.researchRefs`. */
  id: string;
  title: string;
  author: string;
  category: PatternResearchCategory;
  /**
   * Structural CLAIMS the source makes — definitions of geometry / signal /
   * confirmation only. NEVER a profitability or win-rate statement.
   */
  claims: readonly string[];
  /** Pattern-library ids this source informs. */
  patternIds: readonly string[];
  /** Honesty note carried alongside any citation. */
  note: string;
}

const HONESTY_NOTE =
  "A textbook definition, not proof of edge — ARX's own backtest/forward record is the only reliability source of truth.";

export const PATTERN_RESEARCH_SOURCES: readonly PatternResearchSource[] = [
  {
    id: "nison_candlesticks",
    title: "Japanese Candlestick Charting Techniques",
    author: "Steve Nison",
    category: "candlestick",
    claims: [
      "A shooting star is a single candle with a small body near its low and a long upper shadow, appearing after an advance, and is read as a potential bearish reversal once the next candle confirms.",
      "A hammer is a single candle with a small body near its high and a long lower shadow, appearing after a decline, and is read as a potential bullish reversal once confirmed.",
      "An engulfing pattern is a two-candle reversal where the second body fully covers the prior opposite-colour body.",
      "Morning and evening stars are three-candle reversals signalled by a gap/indecision middle candle and a strong confirming third candle.",
    ],
    patternIds: [
      "bearish_pin_bar",
      "bullish_pin_bar",
      "bullish_engulfing",
      "bearish_engulfing",
      "morning_star",
      "evening_star",
    ],
    note: HONESTY_NOTE,
  },
  {
    id: "bulkowski_chart_patterns",
    title: "Encyclopedia of Chart Patterns",
    author: "Thomas Bulkowski",
    category: "chart_pattern",
    claims: [
      "Triangles (ascending, descending, symmetrical) are consolidation structures defined by converging trendlines, resolved by a decisive close beyond a boundary.",
      "Rectangles/ranges are bounded by horizontal support and resistance; the read is a no-edge zone until a boundary breaks and holds.",
      "Flags and pennants are brief continuation pauses after a strong impulse, expected to resolve in the direction of the prior move.",
      "A pattern is only meaningful once its breakout/confirmation level is exceeded on a closing basis.",
    ],
    patternIds: [
      "ascending_triangle",
      "descending_triangle",
      "symmetrical_triangle",
      "rectangle_range",
      "bull_flag",
      "bear_flag",
    ],
    note: HONESTY_NOTE,
  },
  {
    id: "murphy_technical_analysis",
    title: "Technical Analysis of the Financial Markets",
    author: "John J. Murphy",
    category: "market_structure",
    claims: [
      "A trendline is broken only on a decisive CLOSE through it; an intraday wick that does not close beyond the line is not a confirmed break.",
      "Broken support frequently becomes resistance and broken resistance frequently becomes support (a support/resistance 'flip') when retested.",
      "Support and resistance gain significance with more touches and higher timeframe alignment.",
    ],
    patternIds: ["trendline_break", "support_resistance_flip"],
    note: HONESTY_NOTE,
  },
  {
    id: "brooks_price_action",
    title: "Trading Price Action (Trends/Ranges/Reversals)",
    author: "Al Brooks",
    category: "price_action",
    claims: [
      "Most bars are within a trading range; ranges resolve at their extremes and most breakout attempts fail and reverse back into the range.",
      "A second-entry / confirmation bar is preferred over acting on the first signal bar.",
      "Context (trend vs range, location within the structure) dominates the meaning of any single signal bar.",
    ],
    patternIds: ["rectangle_range", "bearish_pin_bar", "bullish_pin_bar"],
    note: HONESTY_NOTE,
  },
  {
    id: "kirkpatrick_dahlquist_cmt",
    title: "Technical Analysis: The Complete Resource for Financial Market Technicians",
    author: "Kirkpatrick & Dahlquist",
    category: "education",
    claims: [
      "Pattern reliability varies by market, timeframe, and volatility regime and must be measured empirically rather than assumed.",
      "Volatility (e.g. ATR) should scale the expected size of breakouts, stops, and targets across instruments.",
    ],
    patternIds: [],
    note: HONESTY_NOTE,
  },
];

/** All sources that inform a given pattern id. */
export function researchForPattern(patternId: string): PatternResearchSource[] {
  return PATTERN_RESEARCH_SOURCES.filter((s) => s.patternIds.includes(patternId));
}

/** Source ids that inform a given pattern id (for `researchRefs`). */
export function researchRefsForPattern(patternId: string): string[] {
  return researchForPattern(patternId).map((s) => s.id);
}

/** Look up a single source by id. */
export function getResearchSource(id: string): PatternResearchSource | null {
  return PATTERN_RESEARCH_SOURCES.find((s) => s.id === id) ?? null;
}

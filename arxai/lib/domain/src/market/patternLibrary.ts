// ── CHART PATTERN LIBRARY — PHASE-1 INVENTORY (Task #617) ─────────────────────
//
// The SINGLE in-repo, typed inventory of every chart pattern the Pattern Truth
// engine is built to recognise, grouped by the six `PatternCategory` families.
// It is the SPEC the detector (`patternEngine.ts`) implements against: for every
// `DetectedPattern.id` the detector can emit there is exactly one entry here,
// describing how the pattern is detected, what confirms/invalidates it, how its
// target is measured, its known failure modes, and the context filters that
// raise or lower its reliability.
//
// PURE DATA + TYPES ONLY. This module imports nothing but the display-side
// pattern enums from the contract in this same package. It has NO IO, NO DB, NO
// clock, and — like the rest of the Pattern Truth layer — it is DISPLAY /
// DECISION-SUPPORT only: it can never be read by an execution/safety surface and
// it grants no trade affordance. It exists so the catalogue of patterns lives in
// version-controlled, type-checked code rather than only in a task document, and
// so a test can cross-check the detector's coverage against the inventory.

import type {
  PatternBias,
  PatternCategory,
  PatternRiskBand,
} from "./patternTruthContract";

/** A pattern can be one-directional or print in both directions. */
export type PatternLibraryBias = PatternBias | "both";

/** One catalogued chart pattern — the detection spec for a single detector id. */
export interface PatternLibraryEntry {
  /** Stable machine key — MUST match the `DetectedPattern.id` the detector emits. */
  id: string;
  /** Human label. */
  name: string;
  category: PatternCategory;
  bias: PatternLibraryBias;
  /** Minimum closed candles the detector needs before it can emit this pattern. */
  minCandles: number;
  /** Measurable geometry/conditions that DEFINE the pattern. */
  detection: string[];
  /** The trigger that turns a forming pattern into a confirmed one. */
  confirmation: string;
  /** The structural event that invalidates the pattern. */
  invalidation: string;
  /** How the measured-move target is projected. */
  target: string;
  /** Known ways the pattern fails — surfaced as honest warnings, never hidden. */
  failureModes: string[];
  /** Context that RAISES or LOWERS reliability (never an execution gate). */
  contextFilters: string[];
  /** Typical false-breakout risk band for the pattern in isolation. */
  falseBreakoutRisk: PatternRiskBand;
}

// ── Group 1 · Reversal ───────────────────────────────────────────────────────
const REVERSAL: PatternLibraryEntry[] = [
  {
    id: "head_and_shoulders",
    name: "Head & Shoulders",
    category: "reversal",
    bias: "bearish",
    minCandles: 30,
    detection: [
      "Three swing highs with a higher central peak (head) between two lower, roughly level shoulders.",
      "A neckline drawn across the intervening troughs.",
    ],
    confirmation: "A close below the neckline.",
    invalidation: "A close back above the head.",
    target: "Neckline minus the head-to-neckline height (measured move).",
    failureModes: [
      "A close back above the head invalidates the reversal.",
      "An asymmetric / sloping neckline weakens the read (false breakout risk).",
    ],
    contextFilters: [
      "Stronger after an extended up-trend (exhaustion context).",
      "Two clean troughs on the neckline raise reliability.",
    ],
    falseBreakoutRisk: "medium",
  },
  {
    id: "inverse_head_and_shoulders",
    name: "Inverse Head & Shoulders",
    category: "reversal",
    bias: "bullish",
    minCandles: 30,
    detection: [
      "Three swing lows with a lower central trough (head) between two higher, roughly level shoulders.",
      "A neckline drawn across the intervening peaks.",
    ],
    confirmation: "A close above the neckline.",
    invalidation: "A close back below the head.",
    target: "Neckline plus the neckline-to-head height (measured move).",
    failureModes: [
      "A close back below the head invalidates the reversal.",
      "A sloping neckline raises false breakout risk.",
    ],
    contextFilters: [
      "Stronger after an extended down-trend (capitulation context).",
      "Two clean peaks on the neckline raise reliability.",
    ],
    falseBreakoutRisk: "medium",
  },
  {
    id: "double_top",
    name: "Double Top",
    category: "reversal",
    bias: "bearish",
    minCandles: 24,
    detection: [
      "Two swing highs at a similar level rejecting the same resistance.",
      "A trough between them defines the neckline.",
    ],
    confirmation: "A close below the trough neckline.",
    invalidation: "A close above the higher of the two tops.",
    target: "Neckline minus the top-to-neckline height.",
    failureModes: ["A close above the higher top invalidates the top."],
    contextFilters: [
      "Near-equal highs (low ATR-normalised spread) raise reliability.",
      "Weaker when the two tops are far apart in time.",
    ],
    falseBreakoutRisk: "medium",
  },
  {
    id: "double_bottom",
    name: "Double Bottom",
    category: "reversal",
    bias: "bullish",
    minCandles: 24,
    detection: [
      "Two swing lows at a similar level holding the same support.",
      "A peak between them defines the neckline.",
    ],
    confirmation: "A close above the peak neckline.",
    invalidation: "A close below the lower of the two bottoms.",
    target: "Neckline plus the neckline-to-bottom height.",
    failureModes: ["A close below the lower bottom invalidates the bottom."],
    contextFilters: [
      "Near-equal lows (low ATR-normalised spread) raise reliability.",
      "Weaker when the two bottoms are far apart in time.",
    ],
    falseBreakoutRisk: "medium",
  },
];

// ── Group 2 · Continuation ───────────────────────────────────────────────────
const CONTINUATION: PatternLibraryEntry[] = [
  {
    id: "bull_flag",
    name: "Bull Flag",
    category: "continuation",
    bias: "bullish",
    minCandles: 20,
    detection: [
      "A strong up impulse (flagpole ≈ 2+ ATR).",
      "A shallow downward counter-trend drift (the flag).",
    ],
    confirmation: "A close above the flag high.",
    invalidation: "A close below the flag low.",
    target: "Breakout level plus the flagpole height (measured move).",
    failureModes: ["A deep pullback through the flag invalidates the continuation."],
    contextFilters: [
      "Stronger when aligned with the higher-timeframe up-trend.",
      "A shallow, tight flag raises reliability; a deep one lowers it.",
    ],
    falseBreakoutRisk: "medium",
  },
  {
    id: "bear_flag",
    name: "Bear Flag",
    category: "continuation",
    bias: "bearish",
    minCandles: 20,
    detection: [
      "A strong down impulse (flagpole ≈ 2+ ATR).",
      "A shallow upward counter-trend drift (the flag).",
    ],
    confirmation: "A close below the flag low.",
    invalidation: "A close above the flag high.",
    target: "Breakout level minus the flagpole height (measured move).",
    failureModes: ["A deep pullback through the flag invalidates the continuation."],
    contextFilters: [
      "Stronger when aligned with the higher-timeframe down-trend.",
      "A shallow, tight flag raises reliability; a deep one lowers it.",
    ],
    falseBreakoutRisk: "medium",
  },
  {
    id: "ascending_triangle",
    name: "Ascending Triangle",
    category: "continuation",
    bias: "bullish",
    minCandles: 12,
    detection: [
      "A flat horizontal resistance with a rising series of higher lows beneath it.",
      "Range compresses toward the apex as buyers press the level.",
    ],
    confirmation: "A close above the flat resistance (close, not a wick).",
    invalidation: "A close below the rising lower trendline.",
    target: "Breakout level plus the triangle's height (measured move).",
    failureModes: [
      "A close back inside the triangle marks a failed breakout.",
      "An intrabar poke that does not close beyond resistance is not a break.",
    ],
    contextFilters: [
      "Stronger when aligned with the higher-timeframe up-trend.",
      "More touches of the flat resistance raise reliability.",
    ],
    falseBreakoutRisk: "medium",
  },
  {
    id: "descending_triangle",
    name: "Descending Triangle",
    category: "continuation",
    bias: "bearish",
    minCandles: 12,
    detection: [
      "A flat horizontal support with a falling series of lower highs above it.",
      "Range compresses toward the apex as sellers press the level.",
    ],
    confirmation: "A close below the flat support (close, not a wick).",
    invalidation: "A close above the falling upper trendline.",
    target: "Breakdown level minus the triangle's height (measured move).",
    failureModes: [
      "A close back inside the triangle marks a failed breakdown.",
      "An intrabar poke that does not close beyond support is not a break.",
    ],
    contextFilters: [
      "Stronger when aligned with the higher-timeframe down-trend.",
      "More touches of the flat support raise reliability.",
    ],
    falseBreakoutRisk: "medium",
  },
  {
    id: "symmetrical_triangle",
    name: "Symmetrical Triangle",
    category: "continuation",
    bias: "both",
    minCandles: 12,
    detection: [
      "Converging trendlines: lower highs and higher lows compressing toward an apex.",
      "Direction is undecided until a boundary breaks.",
    ],
    confirmation: "A decisive close beyond either converging boundary.",
    invalidation: "A close back inside after a break, or drift to the apex with no break.",
    target: "Breakout level plus/minus the triangle's base height (measured move).",
    failureModes: [
      "Direction is unknown until the break — guessing it early is low-signal.",
      "Apex drift without a break dissipates the structure.",
    ],
    contextFilters: [
      "The higher-timeframe trend biases the likely break direction.",
      "A break with expansion is more reliable than a quiet drift-out.",
    ],
    falseBreakoutRisk: "high",
  },
  {
    id: "rectangle_range",
    name: "Rectangle / Range",
    category: "continuation",
    bias: "both",
    minCandles: 12,
    detection: [
      "Roughly flat horizontal support and resistance containing price.",
      "No directional edge inside the band — a balance zone.",
    ],
    confirmation: "A decisive close beyond either the range high or low.",
    invalidation: "A close back inside the range after an attempted break.",
    target: "Breakout level plus/minus the range height (measured move).",
    failureModes: [
      "Mid-range is the lowest-edge spot — acting there is noise.",
      "Range edges produce frequent false breakouts.",
    ],
    contextFilters: [
      "More touches of each edge raise the level's reliability.",
      "A tightening range hints at a coming expansion (not a direction).",
    ],
    falseBreakoutRisk: "high",
  },
];

// ── Group 3 · Breakout + retest ──────────────────────────────────────────────
const BREAKOUT_RETEST: PatternLibraryEntry[] = [
  {
    id: "breakout_retest_up",
    name: "Resistance Breakout & Retest",
    category: "breakout_retest",
    bias: "bullish",
    minCandles: 24,
    detection: [
      "A horizontal resistance touched by two or more swing highs.",
      "A decisive close above it, then a pullback that retests and holds the level as support.",
    ],
    confirmation: "Price holds above the broken level after retesting it.",
    invalidation: "A close back below the broken level.",
    target: "Broken level plus the prior consolidation range, or ≈ 2 ATR.",
    failureModes: [
      "A close back below the level marks a failed breakout (bull trap).",
      "No retest leaves the breakout unconfirmed (forming only).",
    ],
    contextFilters: [
      "Two+ touches of the level before the break raise reliability.",
      "An exhausted run far past the level flags chase risk.",
    ],
    falseBreakoutRisk: "high",
  },
  {
    id: "breakout_retest_down",
    name: "Support Breakdown & Retest",
    category: "breakout_retest",
    bias: "bearish",
    minCandles: 24,
    detection: [
      "A horizontal support touched by two or more swing lows.",
      "A decisive close below it, then a pullback that retests and rejects the level as resistance.",
    ],
    confirmation: "Price holds below the broken level after retesting it.",
    invalidation: "A close back above the broken level.",
    target: "Broken level minus the prior consolidation range, or ≈ 2 ATR.",
    failureModes: [
      "A close back above the level marks a failed breakdown (bear trap).",
      "No retest leaves the breakdown unconfirmed (forming only).",
    ],
    contextFilters: [
      "Two+ touches of the level before the break raise reliability.",
      "An exhausted run far past the level flags chase risk.",
    ],
    falseBreakoutRisk: "high",
  },
];

// ── Group 4 · Candlestick ────────────────────────────────────────────────────
const CANDLESTICK: PatternLibraryEntry[] = [
  {
    id: "bullish_engulfing",
    name: "Bullish Engulfing",
    category: "candlestick",
    bias: "bullish",
    minCandles: 20,
    detection: [
      "A down candle followed by an up candle whose body fully engulfs the prior body.",
      "Printed after a down move or at a swing low.",
    ],
    confirmation: "A close above the engulfing candle's high.",
    invalidation: "A close below the engulfing candle's low.",
    target: "Engulfing high plus ≈ 2× the engulfing range, or the next swing high.",
    failureModes: [
      "Mid-range engulfings (no prior down move) are low-signal noise.",
      "A close below the engulfing low negates the reversal.",
    ],
    contextFilters: [
      "Stronger at a tested support / swing low.",
      "A larger engulfing body relative to the prior body raises reliability.",
    ],
    falseBreakoutRisk: "high",
  },
  {
    id: "bearish_engulfing",
    name: "Bearish Engulfing",
    category: "candlestick",
    bias: "bearish",
    minCandles: 20,
    detection: [
      "An up candle followed by a down candle whose body fully engulfs the prior body.",
      "Printed after an up move or at a swing high.",
    ],
    confirmation: "A close below the engulfing candle's low.",
    invalidation: "A close above the engulfing candle's high.",
    target: "Engulfing low minus ≈ 2× the engulfing range, or the next swing low.",
    failureModes: [
      "Mid-range engulfings (no prior up move) are low-signal noise.",
      "A close above the engulfing high negates the reversal.",
    ],
    contextFilters: [
      "Stronger at a tested resistance / swing high.",
      "A larger engulfing body relative to the prior body raises reliability.",
    ],
    falseBreakoutRisk: "high",
  },
  {
    id: "bullish_pin_bar",
    name: "Bullish Pin Bar (Hammer)",
    category: "candlestick",
    bias: "bullish",
    minCandles: 20,
    detection: [
      "A candle with a long lower wick (≥ 2× the body) and a small upper wick.",
      "Printed after a down move (rejection of lower prices).",
    ],
    confirmation: "A close above the pin bar's high.",
    invalidation: "A close below the pin bar's low.",
    target: "Pin high plus ≈ 2× the pin range.",
    failureModes: [
      "Without follow-through the pin is just a single-candle hint (forming).",
      "A close below the wick low negates the rejection.",
    ],
    contextFilters: [
      "Stronger at a tested support / swing low.",
      "A longer wick relative to range raises reliability.",
    ],
    falseBreakoutRisk: "high",
  },
  {
    id: "bearish_pin_bar",
    name: "Bearish Pin Bar (Shooting Star)",
    category: "candlestick",
    bias: "bearish",
    minCandles: 20,
    detection: [
      "A candle with a long upper wick (≥ 2× the body) and a small lower wick.",
      "Printed after an up move (rejection of higher prices).",
    ],
    confirmation: "A close below the pin bar's low.",
    invalidation: "A close above the pin bar's high.",
    target: "Pin low minus ≈ 2× the pin range.",
    failureModes: [
      "Without follow-through the pin is just a single-candle hint (forming).",
      "A close above the wick high negates the rejection.",
    ],
    contextFilters: [
      "Stronger at a tested resistance / swing high.",
      "A longer wick relative to range raises reliability.",
    ],
    falseBreakoutRisk: "high",
  },
  {
    id: "morning_star",
    name: "Morning Star",
    category: "candlestick",
    bias: "bullish",
    minCandles: 20,
    detection: [
      "A strong down candle, a small-bodied indecision candle, then a strong up candle.",
      "The third candle closes well into the first candle's body, after a down move.",
    ],
    confirmation: "The third candle closes into the first body; a close above its high follows through.",
    invalidation: "A close below the lowest low of the three candles.",
    target: "The next swing high, or ≈ 2× the three-candle range.",
    failureModes: [
      "A large middle body (not true indecision) weakens the read.",
      "A close below the structure low negates the reversal.",
    ],
    contextFilters: [
      "Stronger at a tested support / swing low.",
      "A deeper close into the first body raises reliability.",
    ],
    falseBreakoutRisk: "medium",
  },
  {
    id: "evening_star",
    name: "Evening Star",
    category: "candlestick",
    bias: "bearish",
    minCandles: 20,
    detection: [
      "A strong up candle, a small-bodied indecision candle, then a strong down candle.",
      "The third candle closes well into the first candle's body, after an up move.",
    ],
    confirmation: "The third candle closes into the first body; a close below its low follows through.",
    invalidation: "A close above the highest high of the three candles.",
    target: "The next swing low, or ≈ 2× the three-candle range.",
    failureModes: [
      "A large middle body (not true indecision) weakens the read.",
      "A close above the structure high negates the reversal.",
    ],
    contextFilters: [
      "Stronger at a tested resistance / swing high.",
      "A deeper close into the first body raises reliability.",
    ],
    falseBreakoutRisk: "medium",
  },
];

// ── Group 5 · Structure (liquidity) ──────────────────────────────────────────
const STRUCTURE: PatternLibraryEntry[] = [
  {
    id: "liquidity_sweep_high",
    name: "Liquidity Sweep (high)",
    category: "structure",
    bias: "bearish",
    minCandles: 20,
    detection: [
      "A wick pierces a prior swing high (stop run) then the candle closes back below it.",
    ],
    confirmation: "The close back inside the prior range after the sweep.",
    invalidation: "A close beyond the sweep extreme (high).",
    target: "The nearest prior swing low, or ≈ 2 ATR lower.",
    failureModes: ["A close beyond the sweep extreme negates the reversal."],
    contextFilters: [
      "A deeper pierce relative to ATR raises conviction.",
      "Short-lived — a far run from the sweep is chase risk.",
    ],
    falseBreakoutRisk: "medium",
  },
  {
    id: "liquidity_sweep_low",
    name: "Liquidity Sweep (low)",
    category: "structure",
    bias: "bullish",
    minCandles: 20,
    detection: [
      "A wick pierces a prior swing low (stop run) then the candle closes back above it.",
    ],
    confirmation: "The close back inside the prior range after the sweep.",
    invalidation: "A close beyond the sweep extreme (low).",
    target: "The nearest prior swing high, or ≈ 2 ATR higher.",
    failureModes: ["A close beyond the sweep extreme negates the reversal."],
    contextFilters: [
      "A deeper pierce relative to ATR raises conviction.",
      "Short-lived — a far run from the sweep is chase risk.",
    ],
    falseBreakoutRisk: "medium",
  },
  {
    id: "trendline_break",
    name: "Trendline Break",
    category: "structure",
    bias: "both",
    minCandles: 10,
    detection: [
      "A sloped support/resistance trendline fit across two or more swings.",
      "Price CLOSES beyond the line — a wick poke through it is explicitly not a break.",
    ],
    confirmation: "A candle closes beyond the trendline (close, not a wick).",
    invalidation: "A close back to the broken side of the line.",
    target: "The next structural level, or the prior swing in the break direction.",
    failureModes: [
      "A wick-only pierce that closes back inside is not a valid break.",
      "A steep, recently-drawn line breaks easily (low reliability).",
    ],
    contextFilters: [
      "More touches before the break raise the line's significance.",
      "A break aligned with the higher-timeframe trend is more reliable.",
    ],
    falseBreakoutRisk: "high",
  },
  {
    id: "support_resistance_flip",
    name: "Support/Resistance Flip",
    category: "structure",
    bias: "both",
    minCandles: 10,
    detection: [
      "A horizontal level is broken on a close, then retested from the other side.",
      "Old resistance acts as new support (or old support as new resistance).",
    ],
    confirmation: "Price holds the flipped level on the retest (rejection / hold).",
    invalidation: "A close back through the level negates the flip.",
    target: "The next structural level in the break direction.",
    failureModes: [
      "No clean retest leaves the flip unconfirmed (forming only).",
      "A close back through the level marks a failed flip (trap).",
    ],
    contextFilters: [
      "A level with prior touches flips more reliably.",
      "A flip aligned with the higher-timeframe trend is stronger.",
    ],
    falseBreakoutRisk: "medium",
  },
];

// ── Group 6 · Scalp flare (momentum burst) ───────────────────────────────────
const SCALP_FLARE: PatternLibraryEntry[] = [
  {
    id: "scalp_flare_up",
    name: "Scalp Flare (up)",
    category: "scalp_flare",
    bias: "bullish",
    minCandles: 20,
    detection: [
      "A tight low-volatility base (recent ranges well under ATR).",
      "A decisive expansion candle (≥ 1.5 ATR range, strong up body) breaking out of the base.",
    ],
    confirmation: "The expansion candle closes strongly above the base high.",
    invalidation: "A close back inside / below the base.",
    target: "Base high plus the flare height, or ≈ 2 ATR.",
    failureModes: [
      "A flare that overextends (> ~3 ATR) is a chase, not an entry.",
      "An immediate close back into the base is a failed flare.",
    ],
    contextFilters: [
      "Stronger when the base is genuinely compressed (volatility squeeze).",
      "Synthetic-index flares behave differently and are tracked separately.",
    ],
    falseBreakoutRisk: "high",
  },
  {
    id: "scalp_flare_down",
    name: "Scalp Flare (down)",
    category: "scalp_flare",
    bias: "bearish",
    minCandles: 20,
    detection: [
      "A tight low-volatility base (recent ranges well under ATR).",
      "A decisive expansion candle (≥ 1.5 ATR range, strong down body) breaking out of the base.",
    ],
    confirmation: "The expansion candle closes strongly below the base low.",
    invalidation: "A close back inside / above the base.",
    target: "Base low minus the flare height, or ≈ 2 ATR.",
    failureModes: [
      "A flare that overextends (> ~3 ATR) is a chase, not an entry.",
      "An immediate close back into the base is a failed flare.",
    ],
    contextFilters: [
      "Stronger when the base is genuinely compressed (volatility squeeze).",
      "Synthetic-index flares behave differently and are tracked separately.",
    ],
    falseBreakoutRisk: "high",
  },
];

/** The complete pattern inventory across all six categories. */
export const PATTERN_LIBRARY: readonly PatternLibraryEntry[] = [
  ...REVERSAL,
  ...CONTINUATION,
  ...BREAKOUT_RETEST,
  ...CANDLESTICK,
  ...STRUCTURE,
  ...SCALP_FLARE,
];

/** Every pattern category the inventory covers. */
export const PATTERN_LIBRARY_CATEGORIES: readonly PatternCategory[] = [
  "reversal",
  "continuation",
  "breakout_retest",
  "candlestick",
  "structure",
  "scalp_flare",
];

/** Look up a single catalogued pattern by its stable id. */
export function patternLibraryEntry(id: string): PatternLibraryEntry | null {
  return PATTERN_LIBRARY.find((e) => e.id === id) ?? null;
}

/** All catalogued patterns in one category. */
export function patternLibraryByCategory(
  category: PatternCategory,
): PatternLibraryEntry[] {
  return PATTERN_LIBRARY.filter((e) => e.category === category);
}

/** The set of every catalogued pattern id (for detector cross-checks). */
export function patternLibraryIds(): Set<string> {
  return new Set(PATTERN_LIBRARY.map((e) => e.id));
}

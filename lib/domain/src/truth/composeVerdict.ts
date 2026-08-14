// Task #512 — One Truth, One Brain (pure verdict composer).
//
// Deterministic, side-effect-free composition of the four normalized component
// verdicts + data state + news state + level geometry into ONE composed read.
// The api-server brain does all the I/O and normalization; this module only
// reasons over already-normalized inputs, so every surface that renders from the
// snapshot shows IDENTICAL words and an IDENTICAL verdict.
//
// HONESTY RULES enforced here:
//  - Evidence cites ONLY components that are present in THIS snapshot AND aligned
//    with the read. Absent/blind components are never cited.
//  - When present components disagree, the verdict is CONFLICT and BOTH sides are
//    carried (for + against) — we never silently pick a winner.
//  - Invalidation side is derived purely from level geometry (stop vs entry).
//  - The stale-level guard withholds actionable levels when saved geometry has
//    drifted too far from the current price; we never show stale entries/stops.
//  - Nothing here gates execution. Advisory, read-only.

import type {
  ComposeVerdictInput,
  ComposedLevels,
  ComposedVerdict,
  LevelStalenessInput,
  LevelStalenessResult,
  TruthAlignment,
  TruthBestAction,
  TruthBias,
  TruthComponentInput,
  TruthComponentKey,
  TruthInvalidation,
  TruthLevelInput,
  TruthStage,
} from "./truth.types.js";

/** A level more than this fraction from price is treated as stale geometry. */
const MAX_LEVEL_DEVIATION_PCT = 0.02; // 2%
/** When ATR is known, a level beyond this many ATRs from price is also stale. */
const MAX_LEVEL_ATR_MULTIPLE = 8;

const STALE_LEVEL_REASON =
  "The saved entry, stop, and target are far from the current price, so they are no longer shown.";

/**
 * Pure stale-level guard. Returns `stale:true` when ANY actionable level has
 * drifted further than the deviation cap (or, when ATR is known, the ATR cap)
 * from the current price. With no price we cannot judge, so we do NOT withhold
 * on this basis (other guards still apply upstream).
 */
export function evaluateLevelStaleness(
  input: LevelStalenessInput,
): LevelStalenessResult {
  const { price, levels, atr } = input;
  if (price == null || !Number.isFinite(price) || price === 0) {
    return { stale: false, reason: null };
  }

  const candidates = [
    levels.entryFrom,
    levels.entryTo,
    levels.stopLoss,
    levels.invalidation,
    ...levels.takeProfit,
  ].filter((v): v is number => v != null && Number.isFinite(v));

  const atrUsable = atr != null && Number.isFinite(atr) && atr > 0;

  for (const lvl of candidates) {
    const distance = Math.abs(lvl - price);
    if (distance / Math.abs(price) > MAX_LEVEL_DEVIATION_PCT) {
      return { stale: true, reason: STALE_LEVEL_REASON };
    }
    if (atrUsable && distance / (atr as number) > MAX_LEVEL_ATR_MULTIPLE) {
      return { stale: true, reason: STALE_LEVEL_REASON };
    }
  }

  return { stale: false, reason: null };
}

// ── Evidence templates ──────────────────────────────────────────────────────
//
// Keyed by component + its OWN direction. Reused for BOTH the "for" list (when
// the component agrees with the read) and the "against" list (when it opposes).
// Clean English only — no enum/rule strings ever reach a surface from here.

const DIRECTIONAL_SENTENCE: Record<
  TruthComponentKey,
  { BULLISH: string; BEARISH: string }
> = {
  scanner: {
    BULLISH: "The market scanner reads bullish on this timeframe.",
    BEARISH: "The market scanner reads bearish on this timeframe.",
  },
  flame: {
    BULLISH: "Momentum is pushing to the upside right now.",
    BEARISH: "Momentum is pushing to the downside right now.",
  },
  timing: {
    BULLISH: "Timing conditions favour the long side here.",
    BEARISH: "Timing conditions favour the short side here.",
  },
  scalp: {
    BULLISH: "The scalp read points long.",
    BEARISH: "The scalp read points short.",
  },
};

function directionalSentence(c: TruthComponentInput): string | null {
  if (c.alignment === "BULLISH" || c.alignment === "BEARISH") {
    return DIRECTIONAL_SENTENCE[c.key][c.alignment];
  }
  return null;
}

const BEST_ACTION_TEXT: Record<TruthBestAction, string> = {
  BUY: "Look for a long entry.",
  SELL: "Look for a short entry.",
  WAIT_FOR_DATA: "Wait — the live feed is not confirmed yet.",
  WAIT_FOR_NEWS: "Hold off — a high-impact news event is near.",
  STAND_ASIDE: "Stand aside — the signals disagree right now.",
  WATCH_ONLY: "Watch only — there is no clean setup right now.",
};

function opposite(side: "BULLISH" | "BEARISH"): "BULLISH" | "BEARISH" {
  return side === "BULLISH" ? "BEARISH" : "BULLISH";
}

function midOf(levels: TruthLevelInput): number | null {
  if (levels.entryFrom != null && levels.entryTo != null) {
    return (levels.entryFrom + levels.entryTo) / 2;
  }
  return levels.entryFrom ?? levels.entryTo ?? null;
}

function buildHeadline(
  bias: TruthBias,
  bestAction: TruthBestAction,
): string {
  switch (bias) {
    case "UNKNOWN":
      return "There is not enough confirmed data to read this market yet.";
    case "CONFLICT":
      return "The signals disagree right now — the read is mixed.";
    case "NEUTRAL":
      return "The market looks balanced with no clear edge.";
    case "BULLISH":
      if (bestAction === "WAIT_FOR_DATA")
        return "The read leans bullish, but the live feed is not confirmed.";
      if (bestAction === "WAIT_FOR_NEWS")
        return "The read leans bullish, but a news event is near.";
      if (bestAction === "WATCH_ONLY")
        return "The read leans bullish, but there is no clean entry yet.";
      return "The read leans bullish.";
    case "BEARISH":
      if (bestAction === "WAIT_FOR_DATA")
        return "The read leans bearish, but the live feed is not confirmed.";
      if (bestAction === "WAIT_FOR_NEWS")
        return "The read leans bearish, but a news event is near.";
      if (bestAction === "WATCH_ONLY")
        return "The read leans bearish, but there is no clean entry yet.";
      return "The read leans bearish.";
    default:
      return "There is not enough confirmed data to read this market yet.";
  }
}

/**
 * Compose the one verdict. Pure: same inputs → same output, no clock/I/O.
 */
export function composeVerdict(input: ComposeVerdictInput): ComposedVerdict {
  const present = input.components.filter(
    (c) => c.present && c.alignment !== "UNKNOWN",
  );
  const bullish = present.filter((c) => c.alignment === "BULLISH");
  const bearish = present.filter((c) => c.alignment === "BEARISH");

  const conflict = bullish.length > 0 && bearish.length > 0;

  // ── Bias vote over present directional components ──────────────────────────
  let bias: TruthBias;
  if (present.length === 0) {
    bias = "UNKNOWN";
  } else if (conflict) {
    bias = "CONFLICT";
  } else if (bullish.length > 0) {
    bias = "BULLISH";
  } else if (bearish.length > 0) {
    bias = "BEARISH";
  } else {
    bias = "NEUTRAL";
  }

  // ── Stage from agreement structure ────────────────────────────────────────
  let stage: TruthStage;
  if (present.length === 0) {
    stage = "UNKNOWN";
  } else if (conflict) {
    stage = "CONFLICT";
  } else if (
    (bullish.length >= 2 && bearish.length === 0) ||
    (bearish.length >= 2 && bullish.length === 0)
  ) {
    stage = "ALIGNED";
  } else {
    stage = "DEVELOPING";
  }

  // ── Reference direction for evidence framing ──────────────────────────────
  const refDir: "BULLISH" | "BEARISH" | null =
    bias === "BULLISH"
      ? "BULLISH"
      : bias === "BEARISH"
        ? "BEARISH"
        : conflict
          ? bullish.length >= bearish.length
            ? "BULLISH"
            : "BEARISH"
          : null;

  const evidenceFor: string[] = [];
  const evidenceAgainst: string[] = [];
  if (refDir != null) {
    const against = opposite(refDir);
    for (const c of present) {
      const sentence = directionalSentence(c);
      if (sentence == null) continue;
      if (c.alignment === refDir) evidenceFor.push(sentence);
      else if (c.alignment === against) evidenceAgainst.push(sentence);
    }
  }

  // ── Stale-level guard → withhold actionable geometry ──────────────────────
  const staleness = evaluateLevelStaleness({
    price: input.price,
    levels: input.levels,
    atr: input.atr ?? null,
  });

  const levels: ComposedLevels = staleness.stale
    ? {
        entryFrom: null,
        entryTo: null,
        stopLoss: null,
        invalidation: null,
        takeProfit: [],
        withheld: true,
        withheldReason: staleness.reason,
      }
    : {
        entryFrom: input.levels.entryFrom,
        entryTo: input.levels.entryTo,
        stopLoss: input.levels.stopLoss,
        invalidation: input.levels.invalidation,
        takeProfit: input.levels.takeProfit,
        withheld: false,
        withheldReason: null,
      };

  // ── Invalidation side from geometry (only when levels are shown) ───────────
  // The side is read off the geometry: invalidation/stop relative to the entry
  // mid when an entry zone exists, otherwise relative to the current price. A
  // directional read with a stop but no precise entry zone still reports a side.
  let invalidation: TruthInvalidation | null = null;
  if (!levels.withheld) {
    const invPrice = levels.invalidation ?? levels.stopLoss;
    const ref = midOf(input.levels) ?? input.price;
    if (
      invPrice != null &&
      Number.isFinite(invPrice) &&
      ref != null &&
      Number.isFinite(ref)
    ) {
      invalidation = {
        price: invPrice,
        side: invPrice < ref ? "BELOW" : "ABOVE",
      };
    }
  }

  // ── Best action precedence ────────────────────────────────────────────────
  let bestAction: TruthBestAction;
  if (input.dataState !== "LIVE_CONFIRMED") {
    bestAction = "WAIT_FOR_DATA";
  } else if (bias === "CONFLICT") {
    bestAction = "STAND_ASIDE";
  } else if (input.highImpactWindowActive) {
    bestAction = "WAIT_FOR_NEWS";
  } else if (bias === "BULLISH") {
    bestAction = "BUY";
  } else if (bias === "BEARISH") {
    bestAction = "SELL";
  } else {
    bestAction = "WATCH_ONLY";
  }

  // A directional call with no usable levels degrades to watch-only — we never
  // tell the user to enter without geometry to enter against.
  if (
    (bestAction === "BUY" || bestAction === "SELL") &&
    levels.withheld
  ) {
    bestAction = "WATCH_ONLY";
  }

  return {
    stage,
    bias,
    headline: buildHeadline(bias, bestAction),
    evidenceFor,
    evidenceAgainst,
    bestAction,
    bestActionText: BEST_ACTION_TEXT[bestAction],
    invalidation,
    levels,
  };
}

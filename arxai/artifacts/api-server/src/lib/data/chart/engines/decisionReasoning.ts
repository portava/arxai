// Chart Brain v2 — Task 4: decision-reasoning engine.
//
// "What would change my mind" + the opposite-direction scenario, tied to REAL
// level prices. Deterministic and honest: same state in => same conditions out,
// and when the structure/evidence engines are not populated it says so plainly
// instead of inventing a level. The chart NEVER executes from these reads — they
// are decision-support text only.

import { decimalsFor, round } from "./chartMath.js";
import type {
  ChartEvidenceDirection,
  ChartEvidenceRead,
  ChartLevelsRead,
  ChartTrendRead,
} from "./marketUnderstandingTypes.js";
import type { ChartSetupRead } from "./setupLifecycle.js";

export type ChartReasoningKind = "improve" | "weaken" | "invalidate";

export interface ChartReasoningCondition {
  kind: ChartReasoningKind;
  /** Plain-language, level-tied condition. */
  text: string;
  /** The pivotal price when the condition is tied to a level, else null. */
  price: number | null;
}

export interface ChartOppositeScenario {
  /** The opposite of the current bias. */
  direction: ChartEvidenceDirection;
  /** What would trigger the flip (level-tied). */
  trigger: string;
  triggerPrice: number | null;
  /** What to expect if the opposite plays out. */
  expectation: string;
}

export interface ChartDecisionReasoning {
  populated: boolean;
  /** The bias being reasoned about (mirrors the evidence direction). */
  bias: ChartEvidenceDirection;
  improve: ChartReasoningCondition[];
  weaken: ChartReasoningCondition[];
  invalidate: ChartReasoningCondition[];
  opposite: ChartOppositeScenario | null;
  note: string;
}

export interface DecisionReasoningInputs {
  trend: ChartTrendRead;
  levels: ChartLevelsRead;
  evidence: ChartEvidenceRead;
  setup: ChartSetupRead;
}

function fmt(price: number | null | undefined): number | null {
  if (price == null || !Number.isFinite(price)) return null;
  return round(price, decimalsFor(price));
}

function priceText(price: number | null): string {
  return price != null ? `${price}` : "the level";
}

export function computeDecisionReasoning(
  input: DecisionReasoningInputs,
): ChartDecisionReasoning {
  const { trend, levels, evidence, setup } = input;

  if (!evidence.populated || !levels.populated) {
    return {
      populated: false,
      bias: "unknown",
      improve: [],
      weaken: [],
      invalidate: [],
      opposite: null,
      note: "Not enough structure to reason about what would change the decision.",
    };
  }

  const bias = evidence.direction;
  const improve: ChartReasoningCondition[] = [];
  const weaken: ChartReasoningCondition[] = [];
  const invalidate: ChartReasoningCondition[] = [];

  const support = levels.nearestSupport;
  const resistance = levels.nearestResistance;

  if (bias === "bullish" || bias === "bearish") {
    const directional = bias === "bullish";
    const actionLevel = directional ? support : resistance;
    const barrier = directional ? resistance : support;
    const actionPrice = fmt(actionLevel?.price ?? null);
    const barrierPrice = fmt(barrier?.price ?? null);

    // ── Improve ──────────────────────────────────────────────────────────
    if (actionLevel) {
      improve.push({
        kind: "improve",
        price: actionPrice,
        text: directional
          ? `A firm hold and bounce off support ${priceText(actionPrice)} with buyer follow-through strengthens the long.`
          : `A firm rejection at resistance ${priceText(actionPrice)} with seller follow-through strengthens the short.`,
      });
    }
    if (barrier) {
      improve.push({
        kind: "improve",
        price: barrierPrice,
        text: directional
          ? `A decisive close above resistance ${priceText(barrierPrice)} opens continuation higher.`
          : `A decisive close below support ${priceText(barrierPrice)} opens continuation lower.`,
      });
    }
    if (
      trend.higherTimeframeBias !== bias &&
      (trend.higherTimeframeBias === "bullish" || trend.higherTimeframeBias === "bearish")
    ) {
      improve.push({
        kind: "improve",
        price: null,
        text: `Higher-timeframe bias turning ${bias} would upgrade this from a counter-trend read to an aligned one.`,
      });
    }

    // ── Weaken ───────────────────────────────────────────────────────────
    for (const against of evidence.evidenceAgainst.slice(0, 2)) {
      weaken.push({
        kind: "weaken",
        price: null,
        text: `${against.text} weakens the ${bias} case.`,
      });
    }
    if (barrier && barrier.personality === "defended") {
      weaken.push({
        kind: "weaken",
        price: barrierPrice,
        text: directional
          ? `Defended resistance overhead at ${priceText(barrierPrice)} caps the upside.`
          : `Defended support below at ${priceText(barrierPrice)} cushions the downside.`,
      });
    }
    if (weaken.length === 0 && actionLevel) {
      weaken.push({
        kind: "weaken",
        price: actionPrice,
        text: directional
          ? `Repeated taps of support ${priceText(actionPrice)} without a bounce would weaken the long.`
          : `Repeated taps of resistance ${priceText(actionPrice)} without a rejection would weaken the short.`,
      });
    }

    // ── Invalidate ───────────────────────────────────────────────────────
    const invPrice = fmt(setup.invalidationPrice);
    if (setup.invalidationCondition && invPrice != null) {
      invalidate.push({
        kind: "invalidate",
        price: invPrice,
        text: setup.invalidationCondition,
      });
    } else if (actionLevel) {
      invalidate.push({
        kind: "invalidate",
        price: actionPrice,
        text: directional
          ? `A decisive close below support ${priceText(actionPrice)} invalidates the long.`
          : `A decisive close above resistance ${priceText(actionPrice)} invalidates the short.`,
      });
    }

    // ── Opposite scenario ────────────────────────────────────────────────
    const opp: ChartEvidenceDirection = directional ? "bearish" : "bullish";
    const opposite: ChartOppositeScenario = {
      direction: opp,
      triggerPrice: actionPrice,
      trigger: directional
        ? `A decisive close below support ${priceText(actionPrice)} flips control to sellers.`
        : `A decisive close above resistance ${priceText(actionPrice)} flips control to buyers.`,
      // A bullish read flipping bearish projects DOWN (away from the upside
      // barrier); a bearish read flipping bullish projects UP. We only hold the
      // nearest support/resistance, so there is no concrete next-level target
      // beyond the broken trigger — stay honest: describe the correct direction
      // and the broken level flipping role, never a wrong-side price target.
      expectation: directional
        ? `If that happens, expect downside continuation as broken support ${priceText(actionPrice)} flips to resistance; treat longs as wrong.`
        : `If that happens, expect upside continuation as broken resistance ${priceText(actionPrice)} flips to support; treat shorts as wrong.`,
    };

    return {
      populated: true,
      bias,
      improve,
      weaken,
      invalidate,
      opposite,
      note: `Level-tied conditions for the ${bias} read; opposite scenario is ${opp}.`,
    };
  }

  // ── Neutral / unknown bias — a directional break sets the read ──────────
  const supPrice = fmt(support?.price ?? null);
  const resPrice = fmt(resistance?.price ?? null);
  if (resistance) {
    improve.push({
      kind: "improve",
      price: resPrice,
      text: `A decisive close above resistance ${priceText(resPrice)} would establish a bullish read.`,
    });
  }
  if (support) {
    improve.push({
      kind: "improve",
      price: supPrice,
      text: `A decisive close below support ${priceText(supPrice)} would establish a bearish read.`,
    });
  }
  weaken.push({
    kind: "weaken",
    price: null,
    text: "Continued rotation between the levels keeps this a no-edge market.",
  });

  return {
    populated: true,
    bias: "neutral",
    improve,
    weaken,
    invalidate,
    opposite: null,
    note: "No directional bias yet — a decisive break of the nearest level would set one.",
  };
}

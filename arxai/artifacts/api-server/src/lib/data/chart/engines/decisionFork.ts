// Chart Brain v2 — Task 4: decision fork map + next-candle expectation engine.
//
// Maps the likely branches at the nearest pivotal level (break / hold / fakeout
// / rejection / chop / invalidation) with a likelihood and the read each branch
// leads to, then generates the next 1–3 candle expectations grounded in the
// active setup and candle intent. It also exposes a downgrade signal when the
// expected behaviour is already failing (e.g. a long that is now trapping).
//
// HONESTY: nothing is presented as certainty — branches carry likelihoods, not
// predictions, and when structure/intent is not populated the map is empty with
// an honest note. The chart NEVER executes from this — decision support only.

import { decimalsFor, round } from "./chartMath.js";
import type {
  ChartCandleIntentRead,
  ChartLevel,
  ChartLevelKind,
  ChartLevelsRead,
  ChartTrendRead,
} from "./marketUnderstandingTypes.js";
import type { ChartSetupRead } from "./setupLifecycle.js";

export type ChartForkBranchKind =
  | "break"
  | "hold"
  | "fakeout"
  | "rejection"
  | "chop"
  | "invalidation";

export type ChartLikelihood = "low" | "medium" | "high";

export interface ChartForkBranch {
  kind: ChartForkBranchKind;
  likelihood: ChartLikelihood;
  /** The pivotal price for this branch, when level-tied. */
  price: number | null;
  /** Plain-language description of the branch. */
  text: string;
  /** The read this branch leads to if it plays out. */
  leadsTo: string;
}

export interface ChartCandleExpectation {
  /** 1 = next candle, up to 3. */
  horizon: number;
  text: string;
  confirms: string;
  invalidates: string;
}

export interface ChartDecisionFork {
  populated: boolean;
  pivotPrice: number | null;
  pivotKind: ChartLevelKind | null;
  branches: ChartForkBranch[];
  expectations: ChartCandleExpectation[];
  /** True when the expected behaviour is already failing. */
  downgrade: boolean;
  downgradeReason: string | null;
  note: string;
}

export interface DecisionForkInputs {
  trend: ChartTrendRead;
  levels: ChartLevelsRead;
  candleIntent: ChartCandleIntentRead;
  setup: ChartSetupRead;
}

const LIKELIHOOD_ORDER: Record<ChartLikelihood, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

function byLikelihood(a: ChartForkBranch, b: ChartForkBranch): number {
  return LIKELIHOOD_ORDER[a.likelihood] - LIKELIHOOD_ORDER[b.likelihood];
}

function nearestPivot(levels: ChartLevelsRead): ChartLevel | null {
  const sup = levels.nearestSupport;
  const res = levels.nearestResistance;
  const sd = sup?.distancePct != null ? Math.abs(sup.distancePct) : Infinity;
  const rd = res?.distancePct != null ? Math.abs(res.distancePct) : Infinity;
  if (sup && sd <= rd) return sup;
  if (res) return res;
  return sup ?? null;
}

function fmt(price: number | null | undefined): number | null {
  if (price == null || !Number.isFinite(price)) return null;
  return round(price, decimalsFor(price));
}

function p(price: number | null): string {
  return price != null ? `${price}` : "the level";
}

export function computeDecisionFork(input: DecisionForkInputs): ChartDecisionFork {
  const { trend, levels, candleIntent, setup } = input;

  if (!levels.populated || !candleIntent.populated) {
    return {
      populated: false,
      pivotPrice: null,
      pivotKind: null,
      branches: [],
      expectations: [],
      downgrade: false,
      downgradeReason: null,
      note: "Not enough structure to map decision branches yet.",
    };
  }

  const pivot = nearestPivot(levels);
  if (!pivot) {
    return {
      populated: true,
      pivotPrice: null,
      pivotKind: null,
      branches: [],
      expectations: [],
      downgrade: false,
      downgradeReason: null,
      note: "No nearby level to fork around — price is mid-range.",
    };
  }

  const pivotPrice = fmt(pivot.price);
  const intent = candleIntent.latestIntent;
  const pressure = candleIntent.dominantPressure;
  const regime = trend.regime;
  const isSupport = pivot.kind === "support";

  const breakBias =
    intent === "pushing" || intent === "breaking_structure" || intent === "continuing";
  const trapBias = intent === "trapping" || intent === "failing_to_break";
  const rejectBias = intent === "rejecting" || intent === "exhausting";
  const chopBias =
    regime === "volatile" || regime === "quiet" || intent === "noise" || intent === "absorbing";

  const branches: ChartForkBranch[] = [
    {
      kind: "break",
      likelihood: breakBias ? "high" : trapBias ? "low" : "medium",
      price: pivotPrice,
      text: `A decisive close beyond ${p(pivotPrice)} (${pivot.kind}) with follow-through.`,
      leadsTo: isSupport ? "continuation lower / breakdown" : "continuation higher / breakout",
    },
    {
      kind: "hold",
      likelihood: rejectBias ? "high" : breakBias ? "low" : "medium",
      price: pivotPrice,
      text: `Price respects ${p(pivotPrice)} and rotates back into range.`,
      leadsTo: isSupport ? "bounce / mean reversion up" : "fade / mean reversion down",
    },
    {
      kind: "fakeout",
      likelihood: trapBias ? "high" : "low",
      price: pivotPrice,
      text: `A wick beyond ${p(pivotPrice)} that closes back inside — a trap.`,
      leadsTo: isSupport
        ? "snap-back higher, trapping breakdown sellers"
        : "snap-back lower, trapping breakout buyers",
    },
    {
      kind: "rejection",
      likelihood: rejectBias ? "high" : "medium",
      price: pivotPrice,
      text: `A clear rejection candle at ${p(pivotPrice)}.`,
      leadsTo: isSupport ? "reversal higher off support" : "reversal lower off resistance",
    },
    {
      kind: "chop",
      likelihood: chopBias ? "high" : "low",
      price: pivotPrice,
      text: `Indecisive candles stall around ${p(pivotPrice)} with no follow-through.`,
      leadsTo: "no edge — stand aside until it resolves",
    },
  ];

  const invPrice = fmt(setup.invalidationPrice);
  if (setup.invalidationCondition && invPrice != null) {
    branches.push({
      kind: "invalidation",
      likelihood: setup.stage === "invalid" ? "high" : "low",
      price: invPrice,
      text: setup.invalidationCondition,
      leadsTo: "the active setup is wrong — exit / stand aside",
    });
  }

  branches.sort(byLikelihood);

  // ── Next 1–3 candle expectations ─────────────────────────────────────────
  const expectations: ChartCandleExpectation[] = [];
  const dir = setup.direction;
  if (dir === "bullish" || dir === "bearish") {
    const up = dir === "bullish";
    expectations.push({
      horizon: 1,
      text: up
        ? `Next candle should hold above ${p(pivotPrice)} with buyers defending.`
        : `Next candle should hold below ${p(pivotPrice)} with sellers defending.`,
      confirms: up ? "a close that stays above the level" : "a close that stays below the level",
      invalidates: up
        ? "a decisive close back below the level"
        : "a decisive close back above the level",
    });
    expectations.push({
      horizon: 2,
      text: up
        ? "Within 1–2 candles, expect a higher low / follow-through if the move is real."
        : "Within 1–2 candles, expect a lower high / follow-through if the move is real.",
      confirms: up ? "a higher low forming" : "a lower high forming",
      invalidates: up ? "a lower high stalling the move" : "a higher low stalling the move",
    });
    expectations.push({
      horizon: 3,
      text: up
        ? "Across the next 3 candles, momentum should build, not stall."
        : "Across the next 3 candles, downside pressure should build, not stall.",
      confirms: "expanding range in the trade direction",
      invalidates: "shrinking range / opposing pressure taking over",
    });
  } else {
    expectations.push({
      horizon: 1,
      text: `Next candle: watch the reaction at ${p(pivotPrice)} to set a direction.`,
      confirms: "a decisive close one way",
      invalidates: "another indecisive candle keeping it rangebound",
    });
  }

  // ── Downgrade detector — expected behaviour already failing ──────────────
  let downgrade = false;
  let downgradeReason: string | null = null;
  const failingIntent =
    intent === "failing_to_break" || intent === "trapping" || intent === "exhausting";
  if (dir === "bullish" && (failingIntent || pressure === "sellers")) {
    downgrade = true;
    downgradeReason = `Long expected buyer follow-through but the latest candle reads "${intent}"${pressure === "sellers" ? " with sellers in control" : ""}.`;
  } else if (dir === "bearish" && (failingIntent || pressure === "buyers")) {
    downgrade = true;
    downgradeReason = `Short expected seller follow-through but the latest candle reads "${intent}"${pressure === "buyers" ? " with buyers in control" : ""}.`;
  } else if (setup.stage === "stale" || setup.stage === "invalid") {
    downgrade = true;
    downgradeReason = `Setup stage is ${setup.stage} — the expected window has passed.`;
  }

  return {
    populated: true,
    pivotPrice,
    pivotKind: pivot.kind,
    branches,
    expectations,
    downgrade,
    downgradeReason,
    note: downgrade
      ? `Branches mapped around ${p(pivotPrice)}; setup downgraded — ${downgradeReason}`
      : `Branches mapped around ${pivot.kind} ${p(pivotPrice)} with 1–3 candle expectations.`,
  };
}

// Chart Brain v2 — Task 2, Engine 1: setup lifecycle & decay.
//
// Derives the current setup's stage, freshness, decay and invalidation from the
// trend + level + candle-intent reads. This is a READ-ONLY chart layer with no
// per-user trade join, so the reachable stages are the chart-observable subset
// (no_setup → idea_forming → watchlist → trigger → confirmation_needed →
// entry_valid, plus stale / invalid). The trade_active → review stages require a
// live trade (out of scope here) and are honestly never asserted.
//
// Decay speed is tuned by trade type, which is inferred from the timeframe:
// scalp ideas (M1/M5) decay fastest, intraday (M15/M30/H1) medium, structure
// (H4/D1) slowest. Honest: with no usable trend/levels there is simply no setup.

import type { NormalizedChartCandle } from "../candleNormalization.js";
import type { ChartTimeframe } from "../timeframes.js";
import { atr, clamp, decimalsFor, round } from "./chartMath.js";
import type {
  ChartCandleIntentRead,
  ChartLevelsRead,
  ChartTrendRead,
} from "./marketUnderstandingTypes.js";

export type ChartSetupStage =
  | "no_setup"
  | "idea_forming"
  | "watchlist"
  | "trigger"
  | "confirmation_needed"
  | "entry_valid"
  | "trade_active"
  | "management"
  | "exit"
  | "review"
  | "stale"
  | "invalid";

export type ChartTradeType = "scalp" | "intraday" | "structure" | "unknown";
export type ChartSetupDirection = "bullish" | "bearish" | "none" | "unknown";

export interface ChartSetupRead {
  populated: boolean;
  hasActiveSetup: boolean;
  stage: ChartSetupStage;
  tradeType: ChartTradeType;
  direction: ChartSetupDirection;
  freshness: number | null; // 0-100
  decayScore: number | null; // 0-100 (higher = more decayed)
  ageBars: number | null;
  expiresInBars: number | null;
  invalidationCondition: string | null;
  invalidationPrice: number | null;
  note: string;
}

function tradeTypeFor(tf: ChartTimeframe): ChartTradeType {
  switch (tf) {
    case "M1":
    case "M5":
      return "scalp";
    case "M15":
    case "M30":
    case "H1":
      return "intraday";
    case "H4":
    case "D1":
      return "structure";
    default:
      return "unknown";
  }
}

const HORIZON_BARS: Record<ChartTradeType, number> = {
  scalp: 8,
  intraday: 24,
  structure: 60,
  unknown: 16,
};

/** How many of the most recent bars price has stayed within `band` of `price`. */
function barsNearLevel(
  closed: NormalizedChartCandle[],
  price: number,
  band: number,
): number {
  let count = 0;
  for (let i = closed.length - 1; i >= 0; i--) {
    const c = closed[i]!;
    const near = c.low <= price + band && c.high >= price - band;
    if (near) count++;
    else break;
  }
  return count;
}

function emptySetup(tradeType: ChartTradeType, note: string): ChartSetupRead {
  return {
    populated: true,
    hasActiveSetup: false,
    stage: "no_setup",
    tradeType,
    direction: "none",
    freshness: null,
    decayScore: null,
    ageBars: null,
    expiresInBars: null,
    invalidationCondition: null,
    invalidationPrice: null,
    note,
  };
}

export function computeSetupLifecycle(
  closed: NormalizedChartCandle[],
  timeframe: ChartTimeframe,
  trend: ChartTrendRead,
  levels: ChartLevelsRead,
  candleIntent: ChartCandleIntentRead,
): ChartSetupRead {
  const tradeType = tradeTypeFor(timeframe);
  const n = closed.length;

  if (!trend.populated || !levels.populated || n < 20) {
    return {
      ...emptySetup(tradeType, "Insufficient structure to define a setup."),
      populated: trend.populated && levels.populated,
    };
  }

  const lastClose = closed[n - 1]!.close;
  const atrVal = atr(closed, Math.min(14, n - 1)) ?? 0;
  const band = Math.max(atrVal * 0.6, lastClose * 1e-4);
  const decimals = decimalsFor(lastClose);

  // Directional setups only. A range/mixed read with no edge is no setup.
  let direction: ChartSetupDirection;
  if (trend.direction === "bullish") direction = "bullish";
  else if (trend.direction === "bearish") direction = "bearish";
  else return emptySetup(tradeType, "No directional edge — no setup.");

  // The actionable level: buy from support, sell from resistance.
  const actionLevel =
    direction === "bullish" ? levels.nearestSupport : levels.nearestResistance;
  if (!actionLevel) {
    return {
      ...emptySetup(tradeType, "Directional bias but no actionable level mapped yet."),
      stage: "idea_forming",
      hasActiveSetup: false,
      direction,
    };
  }

  // Disqualify trap zones / invalidated levels outright.
  if (actionLevel.personality === "trap_zone" || actionLevel.personality === "invalidated") {
    return {
      ...emptySetup(tradeType, `Nearest ${actionLevel.kind} is a ${actionLevel.personality} — stand aside.`),
      stage: "invalid",
      direction,
    };
  }

  const distAtr = atrVal > 0 ? Math.abs(lastClose - actionLevel.price) / atrVal : 999;
  const atLevel = distAtr <= 0.6;
  const approaching = distAtr > 0.6 && distAtr <= 2.5;

  // Age: how long price has been working this level (deterministic from window).
  const ageBars = atLevel ? Math.max(1, barsNearLevel(closed, actionLevel.price, band)) : 0;
  const horizon = HORIZON_BARS[tradeType];
  const decayScore = atLevel ? round(clamp((ageBars / horizon) * 100)) : 0;
  const freshness = round(clamp(100 - decayScore));
  const expiresInBars = atLevel ? Math.max(0, horizon - ageBars) : null;

  // Candle-intent confirmation in the trade direction.
  const intent = candleIntent.populated ? candleIntent.latestIntent : "noise";
  const confirmsLong =
    direction === "bullish" &&
    (candleIntent.dominantPressure === "buyers" ||
      intent === "rejecting" ||
      intent === "pushing" ||
      intent === "continuing");
  const confirmsShort =
    direction === "bearish" &&
    (candleIntent.dominantPressure === "sellers" ||
      intent === "rejecting" ||
      intent === "pushing" ||
      intent === "continuing");
  const confirms = confirmsLong || confirmsShort;
  const trapWarn = intent === "trapping" || intent === "failing_to_break";

  // Invalidation: a decisive close beyond the level by a band.
  const invalidationPrice =
    direction === "bullish"
      ? round(actionLevel.price - band, decimals)
      : round(actionLevel.price + band, decimals);
  const invalidationCondition =
    direction === "bullish"
      ? `A decisive close below ${invalidationPrice} invalidates the long setup.`
      : `A decisive close above ${invalidationPrice} invalidates the short setup.`;

  // Stage resolution.
  let stage: ChartSetupStage;
  if (atLevel && decayScore >= 100) {
    stage = "stale";
  } else if (atLevel && trapWarn) {
    stage = "invalid";
  } else if (atLevel && confirms) {
    stage = "entry_valid";
  } else if (atLevel && !confirms) {
    stage = "confirmation_needed";
  } else if (approaching) {
    stage = "watchlist";
  } else {
    stage = "idea_forming";
  }

  const hasActiveSetup = stage === "confirmation_needed" || stage === "entry_valid";

  return {
    populated: true,
    hasActiveSetup,
    stage,
    tradeType,
    direction,
    freshness: atLevel ? freshness : null,
    decayScore: atLevel ? decayScore : null,
    ageBars: atLevel ? ageBars : null,
    expiresInBars,
    invalidationCondition,
    invalidationPrice,
    note: `${direction} ${tradeType} setup at ${actionLevel.kind} ${actionLevel.price} — stage ${stage}.`,
  };
}

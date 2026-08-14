// Phase UX6 — Trade-specific market context.
//
// Compares a resolved trade against the market context + classification
// and returns a trade-direction label + the watch level + scenarios.

import type { MarketContext } from "./contextBuilder.js";
import type { ClassificationResult } from "./classifier.js";
import type { KeyLevels } from "./keyLevels.js";

export type TrendAlignment = "ALIGNED" | "FIGHTING" | "NEUTRAL" | "UNKNOWN";

export type TradeLabel =
  | "Trade aligned with trend" | "Trade fighting trend"
  | "Trade still valid" | "Trade weakening"
  | "Trade invalidation near" | "Trade at decision level"
  | "Profit protection needed" | "Exit review recommended"
  | "Data insufficient";

export interface TradeContextResult {
  trendAlignment: TrendAlignment;
  tradeLabel: TradeLabel;
  bullishScenario: string;
  bearishScenario: string;
  exitHoldReview: string;
  rationale: string[];
  dataQuality: MarketContext["dataQuality"];
}

export interface TradeContextInput {
  side: "BUY" | "SELL";
  entryPrice: number | null;
  currentPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  ctx: MarketContext;
  classification: ClassificationResult;
  keyLevels: KeyLevels;
  unrealizedPnl?: number | null;
  peakPnl?: number | null;
}

export function buildTradeContext(input: TradeContextInput): TradeContextResult {
  const { side, currentPrice, ctx, classification, keyLevels } = input;
  const rationale: string[] = [];

  if (!classification.primaryTimeframe || ctx.dataQuality.quality === "insufficient" || currentPrice == null) {
    return {
      trendAlignment: "UNKNOWN",
      tradeLabel: "Data insufficient",
      bullishScenario: "Cannot project a bullish scenario without live candle data.",
      bearishScenario: "Cannot project a bearish scenario without live candle data.",
      exitHoldReview: "Live market data is not available. The system cannot recommend hold or close on price-action grounds; rely on your own plan and risk rules.",
      rationale: ["No primary timeframe available."],
      dataQuality: ctx.dataQuality,
    };
  }

  const primary = ctx.timeframes[classification.primaryTimeframe];
  const htf = classification.htfTimeframe ? ctx.timeframes[classification.htfTimeframe] : null;

  // Trend alignment.
  let alignment: TrendAlignment = "NEUTRAL";
  const sideUp = side === "BUY";
  const primaryUp = primary.trendDirection === "UP";
  const primaryDown = primary.trendDirection === "DOWN";
  if ((sideUp && primaryUp) || (!sideUp && primaryDown)) alignment = "ALIGNED";
  else if ((sideUp && primaryDown) || (!sideUp && primaryUp)) alignment = "FIGHTING";
  if (htf) {
    if ((sideUp && htf.trendDirection === "DOWN") || (!sideUp && htf.trendDirection === "UP")) {
      alignment = alignment === "ALIGNED" ? "NEUTRAL" : "FIGHTING";
      rationale.push(`HTF ${htf.timeframe} disagrees with trade side.`);
    }
  }

  // Distance to invalidation in ATR units.
  const atr = primary.atr;
  const inv = keyLevels.invalidationLevel;
  const distToInv = inv != null ? Math.abs(currentPrice - inv) : null;
  const invAtr = distToInv != null && atr ? distToInv / atr : null;

  // Trade label decision tree.
  let tradeLabel: TradeLabel = "Trade still valid";
  if (classification.label === "Data insufficient") tradeLabel = "Data insufficient";
  else if (alignment === "FIGHTING") tradeLabel = "Trade fighting trend";
  else if (classification.label === "Reversal risk rising") tradeLabel = "Trade weakening";
  else if (classification.label === "Possible fakeout" || classification.label === "Failed breakout") tradeLabel = "Trade weakening";
  else if (classification.label === "Liquidity sweep possible") tradeLabel = "Trade at decision level";
  else if (alignment === "ALIGNED" && (classification.label === "Strong continuation" || classification.label === "Breakout holding")) {
    tradeLabel = "Trade aligned with trend";
  } else if (alignment === "ALIGNED" && classification.label === "Healthy pullback") tradeLabel = "Trade still valid";
  else if (classification.label === "Deep retracement") tradeLabel = "Trade at decision level";
  if (invAtr != null && invAtr < 0.5) tradeLabel = "Trade invalidation near";

  // Profit protection / exit review on peak fade.
  const peak = input.peakPnl ?? 0;
  const pnl = input.unrealizedPnl ?? 0;
  if (peak > 0 && pnl > 0 && pnl < peak * 0.5) {
    tradeLabel = "Profit protection needed";
    rationale.push(`P&L has faded from peak ${peak.toFixed(2)} to ${pnl.toFixed(2)}.`);
  }
  if (peak > 0 && pnl <= 0) tradeLabel = "Exit review recommended";

  // Scenario narratives — explicitly cautious.
  const upSide = side === "BUY";
  const continuationLvl = keyLevels.continuationLevel;
  const invLvl = keyLevels.invalidationLevel;
  const bullishScenario = upSide
    ? `If price holds above ${invLvl ?? "the invalidation level"} and reclaims ${continuationLvl ?? "resistance"}, the trade may continue toward the next resistance zone.`
    : `If price reclaims ${invLvl ?? "the invalidation level"}, the short setup weakens and the move may extend into a counter-trend bounce.`;
  const bearishScenario = upSide
    ? `If price breaks ${invLvl ?? "the invalidation level"}, the bullish structure breaks and a deeper retrace becomes likely.`
    : `If price holds below ${invLvl ?? "the invalidation level"} and rejects ${continuationLvl ?? "support"}, the move may continue lower toward the next support zone.`;

  const exitHoldReview = (() => {
    switch (tradeLabel) {
      case "Trade aligned with trend": return "Conditions favor holding while the trend stays intact. Watch the invalidation level.";
      case "Trade still valid": return "No invalidation triggered. Holding is consistent with the current structure; reassess if the watch level breaks.";
      case "Trade weakening": return "Structure is showing weakness. Review your stop, consider a partial close, or wait for confirmation before adding.";
      case "Trade fighting trend": return "Trade is against the higher-timeframe trend. Tight risk management is essential; consider an exit review.";
      case "Trade invalidation near": return "Price is close to the invalidation level. A break here would invalidate the setup — review close.";
      case "Trade at decision level": return "Market is at a decision level. Wait for confirmation before adding; consider a partial close to manage risk.";
      case "Profit protection needed": return "Profit has faded from peak. Consider moving stop to breakeven or a partial close.";
      case "Exit review recommended": return "Conditions have shifted against the trade since peak. Consider opening Review Close.";
      case "Data insufficient": return "Live market data is not available. No hold/close recommendation can be made from price action.";
    }
  })();

  rationale.push(
    `${classification.primaryTimeframe} ${primary.trendDirection} (strength ${primary.trendStrengthScore})`,
    ...(htf ? [`${htf.timeframe} ${htf.trendDirection} (strength ${htf.trendStrengthScore})`] : []),
    ...(invAtr != null ? [`Distance to invalidation ≈ ${invAtr.toFixed(2)} ATR`] : []),
    ...classification.evidence.slice(0, 3),
  );

  return {
    trendAlignment: alignment, tradeLabel,
    bullishScenario, bearishScenario, exitHoldReview,
    rationale, dataQuality: ctx.dataQuality,
  };
}

import type { Trade } from "@workspace/db";
import { analyzeTradeOutcome } from "./tradeOutcomeAnalyzer.js";

export interface CoachExplanation {
  whatHappened: string;
  setupValid: string;
  whatCouldBeBetter: string;
  strategyAdjustment: string;
  marketAvoidance: string;
}

export function coachTrade(trade: Trade): CoachExplanation {
  const exit = trade.status === "CLOSED_WIN" || trade.status === "CLOSED_LOSS"
    ? (trade.pnl ?? 0) >= 0
      ? trade.takeProfit
      : trade.stopLoss
    : trade.entryPrice;

  const r = analyzeTradeOutcome({
    symbol: trade.symbol,
    strategy: trade.strategy,
    confidence: trade.confidence,
    entry: trade.entryPrice,
    stopLoss: trade.stopLoss,
    takeProfit: trade.takeProfit,
    exit,
    profitLoss: trade.pnl ?? 0,
  });

  const direction = trade.direction === "BUY" ? "long" : "short";
  const result = r.outcome === "win" ? "won" : r.outcome === "loss" ? "lost" : "broke even";
  const moneyDelta = (trade.pnl ?? 0).toFixed(2);

  return {
    whatHappened: `Took a ${direction} on ${trade.symbol} at ${trade.entryPrice} using ${trade.strategy} (confidence ${trade.confidence}%). The trade ${result} for ${moneyDelta}.`,
    setupValid: r.successTags.length > r.mistakeTags.length
      ? `Setup looked valid: ${r.successTags.slice(0, 2).join(", ")}.`
      : r.mistakeTags.length > 0
        ? `Setup had warning signs: ${r.mistakeTags.slice(0, 2).join(", ")}.`
        : `Setup was acceptable but not exceptional.`,
    whatCouldBeBetter: r.mistakeTags.length === 0
      ? "Nothing major — execution looked clean."
      : `Avoid: ${r.mistakeTags.slice(0, 3).join("; ")}.`,
    strategyAdjustment: r.suggestedAdjustment,
    marketAvoidance: r.outcome === "loss" && r.mistakeTags.includes("entered during chop")
      ? `Avoid ${trade.symbol} when the market is in a sideways range.`
      : r.outcome === "loss" && r.mistakeTags.includes("entered before news")
        ? `Avoid ${trade.symbol} around major economic news.`
        : "No specific avoidance — conditions were within normal range.",
  };
}

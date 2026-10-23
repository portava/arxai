import type { Trade } from "@workspace/db";
import { getLatestQuote } from "../data/dataManager.js";
import { tradeHealthScore } from "./monitoring/tradeHealthScore.js";
import { breakEvenSuggestion } from "./rules/breakEvenRules.js";
import { trailingStopSuggestion } from "./rules/trailingStopRules.js";
import { partialCloseSuggestion } from "./rules/partialCloseRules.js";
import { earlyExitSuggestion } from "./rules/earlyExitRules.js";

export interface TradeManagementSnapshot {
  tradeId: number;
  currentPrice: number;
  rMultiple: number;
  floatingPnl: number;
  health: ReturnType<typeof tradeHealthScore>;
  suggestions: {
    breakEven: ReturnType<typeof breakEvenSuggestion>;
    trail: ReturnType<typeof trailingStopSuggestion>;
    partial: ReturnType<typeof partialCloseSuggestion>;
    earlyExit: ReturnType<typeof earlyExitSuggestion>;
  };
  primarySuggestion: string;
  invalidated: boolean;
}

export async function evaluateTrade(trade: Trade): Promise<TradeManagementSnapshot> {
  const quote = await getLatestQuote(trade.symbol);
  const currentPrice = quote.last ?? trade.entryPrice;
  const risk = Math.abs(trade.entryPrice - trade.stopLoss) || 1e-6;
  const direction = trade.direction === "BUY" ? 1 : -1;
  const rMultiple = ((currentPrice - trade.entryPrice) * direction) / risk;
  const floatingPnl = (currentPrice - trade.entryPrice) * direction * trade.lot * 100;

  const health = tradeHealthScore(trade, currentPrice);
  const suggestions = {
    breakEven: breakEvenSuggestion(trade, currentPrice, rMultiple),
    trail: trailingStopSuggestion(trade, currentPrice, rMultiple),
    partial: partialCloseSuggestion(trade, currentPrice, rMultiple),
    earlyExit: earlyExitSuggestion(trade, currentPrice, rMultiple, health.score),
  };

  const ranked: Array<{ suggestion: string; priority: number }> = [];
  if (suggestions.earlyExit.recommended) ranked.push({ suggestion: suggestions.earlyExit.reason, priority: 4 });
  if (suggestions.partial.recommended) ranked.push({ suggestion: suggestions.partial.reason, priority: 3 });
  if (suggestions.trail.recommended) ranked.push({ suggestion: suggestions.trail.reason, priority: 2 });
  if (suggestions.breakEven.recommended) ranked.push({ suggestion: suggestions.breakEven.reason, priority: 1 });
  ranked.sort((a, b) => b.priority - a.priority);

  return {
    tradeId: trade.id,
    currentPrice,
    rMultiple,
    floatingPnl,
    health,
    suggestions,
    primarySuggestion: ranked[0]?.suggestion ?? "Hold — no action recommended.",
    invalidated: suggestions.earlyExit.recommended,
  };
}

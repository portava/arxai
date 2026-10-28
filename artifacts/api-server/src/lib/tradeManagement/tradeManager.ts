import type { Trade } from "@workspace/db";
import { getLatestQuote } from "../data/dataManager.js";
import { tradeHealthScore, type TradeHealth } from "./monitoring/tradeHealthScore.js";
import { breakEvenSuggestion } from "./rules/breakEvenRules.js";
import { trailingStopSuggestion } from "./rules/trailingStopRules.js";
import { partialCloseSuggestion } from "./rules/partialCloseRules.js";
import { earlyExitSuggestion } from "./rules/earlyExitRules.js";

// Truth rule: Current / R / P&L / Health are only reported when a real quote
// was observed. With no quote they are null and `priceUnavailableReason` says
// why — never the entry price, $0.00 and 0.00R as if the trade were flat.
export interface TradeManagementSnapshot {
  tradeId: number;
  /** Last price from the market-data router; null when no quote was available. */
  currentPrice: number | null;
  /** Timestamp of the quote `currentPrice` came from; null when there is no quote. */
  quoteAt: string | null;
  /** Why currentPrice (and everything derived from it) is null; null when priced. */
  priceUnavailableReason: string | null;
  rMultiple: number | null;
  floatingPnl: number | null;
  health: TradeHealth | null;
  suggestions: {
    breakEven: ReturnType<typeof breakEvenSuggestion>;
    trail: ReturnType<typeof trailingStopSuggestion>;
    partial: ReturnType<typeof partialCloseSuggestion>;
    earlyExit: ReturnType<typeof earlyExitSuggestion>;
  };
  primarySuggestion: string;
  invalidated: boolean;
}

function isPrice(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x) && x > 0;
}

export async function evaluateTrade(trade: Trade): Promise<TradeManagementSnapshot> {
  const quote = await getLatestQuote(trade.symbol);
  if (!isPrice(quote.last)) {
    const reason = `No current quote for ${trade.symbol} from the market-data feed — price, P&L, R and health cannot be measured right now.`;
    const unavailable = { recommended: false as const, reason };
    return {
      tradeId: trade.id,
      currentPrice: null,
      quoteAt: null,
      priceUnavailableReason: reason,
      rMultiple: null,
      floatingPnl: null,
      health: null,
      suggestions: { breakEven: unavailable, trail: unavailable, partial: unavailable, earlyExit: unavailable },
      primarySuggestion: reason,
      invalidated: false,
    };
  }
  const currentPrice = quote.last;
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
    quoteAt: quote.timestamp,
    priceUnavailableReason: null,
    rMultiple,
    floatingPnl,
    health,
    suggestions,
    primarySuggestion: ranked[0]?.suggestion ?? "Hold — no action recommended.",
    invalidated: suggestions.earlyExit.recommended,
  };
}

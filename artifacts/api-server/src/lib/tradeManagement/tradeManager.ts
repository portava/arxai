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
  /**
   * Unrealised P/L in account currency — ALWAYS null on this path.
   *
   * This module has no contract size, no pip value and no quote-currency
   * conversion. The previous implementation was
   *   (currentPrice - entryPrice) * direction * lot * 100
   * — a universal x100 that priced a JPY pair, an index and a gold position
   * identically. That invented dollar amount was written straight into
   * `trades.pnl` by POST /trade-management/:id/close and then flowed into
   * "Realized P/L" on Account Analytics and "Realized P&L" on Portfolio.
   * The only honest value here is null with a reason.
   */
  floatingPnl: number | null;
  floatingPnlStatus: "NOT_PRICEABLE" | "COMPUTED";
  /** Signed price distance from entry, positive when in profit. Unit-free of dollars. */
  priceMove: number;
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
  // Signed price move only. No dollar figure is produced here — see the
  // `floatingPnl` doc comment on TradeManagementSnapshot.
  const priceMove = (currentPrice - trade.entryPrice) * direction;

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
    floatingPnl: null,
    floatingPnlStatus: "NOT_PRICEABLE",
    priceMove,
    health,
    suggestions,
    primarySuggestion: ranked[0]?.suggestion ?? "Hold — no action recommended.",
    invalidated: suggestions.earlyExit.recommended,
  };
}

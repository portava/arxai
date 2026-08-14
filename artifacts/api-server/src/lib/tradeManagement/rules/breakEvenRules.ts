import type { Trade } from "@workspace/db";

export function breakEvenSuggestion(trade: Trade, currentPrice: number, rMultiple: number) {
  const ageMin = trade.createdAt ? (Date.now() - new Date(trade.createdAt).getTime()) / 60000 : 0;
  if (rMultiple < 1) return { recommended: false, reason: "Not yet at 1R" };
  if (ageMin < 1) return { recommended: false, reason: "Trade too new — give it room" };
  // Check distance: don't move BE if price is right at entry
  const dir = trade.direction === "BUY" ? 1 : -1;
  if ((currentPrice - trade.entryPrice) * dir < (trade.entryPrice * 0.0005)) {
    return { recommended: false, reason: "Price too close to entry — wait for clearance" };
  }
  return {
    recommended: true,
    reason: `Price reached ${rMultiple.toFixed(2)}R — move stop to break-even to lock in zero risk.`,
    newStop: trade.entryPrice,
  };
}

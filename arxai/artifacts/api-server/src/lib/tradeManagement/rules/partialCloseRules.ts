import type { Trade } from "@workspace/db";

export function partialCloseSuggestion(trade: Trade, _currentPrice: number, rMultiple: number) {
  if (rMultiple >= 1.5 && rMultiple < 2.5) {
    return {
      recommended: true,
      reason: `At ${rMultiple.toFixed(2)}R — close 50% to bank profit, ride the rest with break-even stop.`,
      closePct: 50,
    };
  }
  if (rMultiple >= 2.5) {
    return {
      recommended: true,
      reason: `At ${rMultiple.toFixed(2)}R — take 75% off and trail the runner.`,
      closePct: 75,
    };
  }
  return { recommended: false, reason: "Not yet in profit zone for partials" };
}

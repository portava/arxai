import type { Trade } from "@workspace/db";

export function earlyExitSuggestion(trade: Trade, currentPrice: number, rMultiple: number, healthScore: number) {
  const dir = trade.direction === "BUY" ? 1 : -1;
  const drawdownR = -rMultiple;
  if (drawdownR > 0.7 && healthScore < 30) {
    return { recommended: true, reason: `Trade thesis invalidated. Health ${healthScore}/100, down ${drawdownR.toFixed(2)}R. Cut now to preserve capital.` };
  }
  if (drawdownR > 0.9) {
    return { recommended: true, reason: `Down ${drawdownR.toFixed(2)}R — almost a full stop loss. Close manually if structure is broken.` };
  }
  // Strong adverse move from a peak (sliding back through entry)
  if (rMultiple < 0 && (currentPrice - trade.entryPrice) * dir < -Math.abs(trade.entryPrice * 0.003)) {
    return { recommended: true, reason: "Strong reversal candle pushed price below entry — exit suggested." };
  }
  return { recommended: false, reason: "Trade thesis still intact" };
}

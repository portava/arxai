import type { Trade } from "@workspace/db";

export function trailingStopSuggestion(trade: Trade, currentPrice: number, rMultiple: number) {
  if (rMultiple < 1.5) return { recommended: false, reason: "Wait for ≥ 1.5R before trailing" };
  const dir = trade.direction === "BUY" ? 1 : -1;
  // Use ATR-like proxy: 0.6× original risk distance
  const trailDistance = Math.abs(trade.entryPrice - trade.stopLoss) * 0.6;
  const newStop = currentPrice - dir * trailDistance;
  // Only suggest if trailing improves on existing stop
  const improves = dir === 1 ? newStop > trade.stopLoss : newStop < trade.stopLoss;
  if (!improves) return { recommended: false, reason: "Existing stop already protective enough" };
  return {
    recommended: true,
    reason: `Trail stop to ${newStop.toFixed(5)} (0.6× initial risk behind price). Locks in ~${(rMultiple - 0.6).toFixed(2)}R.`,
    newStop,
  };
}

import type { Trade, TradeSnapshot } from "./trade.types";

export type TradeHealthState = "HEALTHY" | "AT_RISK" | "CRITICAL" | "WINNING" | "RUNNER";

export interface TradeHealthReport {
  score: number;           // 0..100, higher = healthier
  state: TradeHealthState;
  rMultiple: number;       // current R relative to original SL distance
  distanceToSL: number;    // absolute price distance to SL (positive = safe)
  distanceToTP: number | null;
  reasons: string[];
}

// Pure: given the original trade and a market snapshot, score it 0..100.
//   100 = sitting at TP / deep runner
//    50 = neutral
//     0 = at SL or beyond
export function computeTradeHealth(snap: TradeSnapshot): TradeHealthReport {
  const { trade, currentPrice } = snap;
  const reasons: string[] = [];

  const slDistanceOriginal = Math.abs(trade.entryPrice - trade.stopLoss);
  if (slDistanceOriginal === 0) {
    return {
      score: 50, state: "AT_RISK",
      rMultiple: 0, distanceToSL: 0, distanceToTP: null,
      reasons: ["SL equals entry — invalid risk distance"],
    };
  }

  const sign = trade.direction === "BUY" ? 1 : -1;
  const moveFromEntry = (currentPrice - trade.entryPrice) * sign;
  const rMultiple = moveFromEntry / slDistanceOriginal;
  const distanceToSL = (currentPrice - trade.stopLoss) * sign;
  const distanceToTP = trade.takeProfit != null
    ? (trade.takeProfit - currentPrice) * sign
    : null;

  // Score: map R-multiple -2..+3 onto 0..100
  const clamped = Math.max(-2, Math.min(3, rMultiple));
  const score = Math.round(((clamped + 2) / 5) * 100);

  let state: TradeHealthState = "HEALTHY";
  if (rMultiple <= -0.85) { state = "CRITICAL"; reasons.push("Within 15% of stop loss"); }
  else if (rMultiple <= -0.4) { state = "AT_RISK"; reasons.push("Approaching stop loss"); }
  else if (rMultiple >= 2)    { state = "RUNNER"; reasons.push("Above 2R — consider trailing"); }
  else if (rMultiple >= 0.8)  { state = "WINNING"; reasons.push("Trade in clear profit"); }

  if (distanceToTP != null && distanceToTP <= 0) reasons.push("TP reached or exceeded");

  return { score, state, rMultiple, distanceToSL, distanceToTP, reasons };
}

export function isInProfit(t: Trade, currentPrice: number): boolean {
  return t.direction === "BUY" ? currentPrice > t.entryPrice : currentPrice < t.entryPrice;
}

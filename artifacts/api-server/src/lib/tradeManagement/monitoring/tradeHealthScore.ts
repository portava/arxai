import type { Trade } from "@workspace/db";

export interface TradeHealth {
  score: number; // 0-100
  factors: Record<string, number>;
  state: "healthy" | "watching" | "at_risk" | "invalidated";
}

export function tradeHealthScore(trade: Trade, currentPrice: number): TradeHealth {
  const dir = trade.direction === "BUY" ? 1 : -1;
  const risk = Math.abs(trade.entryPrice - trade.stopLoss) || 1e-6;
  const reward = Math.abs(trade.takeProfit - trade.entryPrice) || 1e-6;
  const distFromStop = (currentPrice - trade.stopLoss) * dir;
  const distFromTp = (trade.takeProfit - currentPrice) * dir;
  const ageMin = trade.createdAt ? (Date.now() - new Date(trade.createdAt).getTime()) / 60000 : 0;

  // Each factor scaled 0..100
  const f = {
    distanceFromStop: clamp((distFromStop / risk) * 60 + 40, 0, 100),
    distanceFromTp: clamp(100 - (distFromTp / reward) * 80, 0, 100),
    structureSupport: trade.confidence,
    spreadState: 80,
    sessionQuality: sessionScore(),
    timeInTrade: ageMin < 60 ? 80 : ageMin < 240 ? 65 : 45,
    oppositeSignalRisk: distFromStop < 0 ? 10 : 70,
    volatilityState: 70,
  };

  const weights: Record<keyof typeof f, number> = {
    distanceFromStop: 0.25,
    distanceFromTp: 0.15,
    structureSupport: 0.15,
    spreadState: 0.05,
    sessionQuality: 0.1,
    timeInTrade: 0.1,
    oppositeSignalRisk: 0.15,
    volatilityState: 0.05,
  };

  const score = Math.round(
    (Object.keys(f) as (keyof typeof f)[]).reduce((sum, k) => sum + f[k] * weights[k], 0),
  );

  const state: TradeHealth["state"] =
    score >= 70 ? "healthy" : score >= 50 ? "watching" : score >= 25 ? "at_risk" : "invalidated";

  return { score: clamp(score, 0, 100), factors: f, state };
}

function sessionScore(): number {
  const h = new Date().getUTCHours();
  if (h >= 7 && h < 16) return 90; // London + NY overlap
  if (h >= 0 && h < 7) return 60; // Asia
  return 50;
}

function clamp(n: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, n)); }

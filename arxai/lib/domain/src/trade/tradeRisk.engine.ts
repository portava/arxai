import type { Trade } from "./trade.types";

export interface TradeRiskBreakdown {
  riskAmount: number;        // currency at risk if SL is hit
  riskPct: number;           // % of accountBalance
  rewardAmount: number | null;
  rewardPct: number | null;
  rrRatio: number | null;    // reward / risk
  isWithinLimits: boolean;
  notes: string[];
}

// Pure risk math. `pipValue` is the per-lot, per-pip currency value supplied
// by the caller (it depends on broker + symbol); when pipValue is unknown the
// caller can still get rrRatio from price distances alone.
export function computeTradeRisk(args: {
  trade: Trade;
  accountBalance: number;
  maxRiskPct?: number;       // soft cap (e.g. 1)
  pipValue?: number;         // currency per pip per lot
  pipSize?: number;          // price units per pip (e.g. 0.0001 for EURUSD)
}): TradeRiskBreakdown {
  const { trade, accountBalance, maxRiskPct = 1, pipValue, pipSize } = args;
  const notes: string[] = [];

  const slDistance = Math.abs(trade.entryPrice - trade.stopLoss);
  const tpDistance = trade.takeProfit != null
    ? Math.abs(trade.takeProfit - trade.entryPrice)
    : null;

  let riskAmount = 0;
  if (pipValue != null && pipSize != null && pipSize > 0) {
    const slPips = slDistance / pipSize;
    riskAmount = slPips * pipValue * trade.lotSize;
  } else {
    notes.push("pipValue/pipSize not provided — riskAmount approximated from price distance × lot size");
    riskAmount = slDistance * trade.lotSize;
  }

  const rewardAmount = tpDistance != null
    ? (pipValue != null && pipSize != null && pipSize > 0
        ? (tpDistance / pipSize) * pipValue * trade.lotSize
        : tpDistance * trade.lotSize)
    : null;

  const riskPct = accountBalance > 0 ? (riskAmount / accountBalance) * 100 : 0;
  const rewardPct = rewardAmount != null && accountBalance > 0
    ? (rewardAmount / accountBalance) * 100
    : null;

  const rrRatio = tpDistance != null && slDistance > 0 ? tpDistance / slDistance : null;
  const isWithinLimits = riskPct <= maxRiskPct;
  if (!isWithinLimits) notes.push(`Risk ${riskPct.toFixed(2)}% exceeds cap of ${maxRiskPct}%`);
  if (rrRatio != null && rrRatio < 1) notes.push(`R:R ${rrRatio.toFixed(2)} below 1:1`);

  return { riskAmount, riskPct, rewardAmount, rewardPct, rrRatio, isWithinLimits, notes };
}

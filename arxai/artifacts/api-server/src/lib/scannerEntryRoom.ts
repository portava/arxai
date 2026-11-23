import type { ChartLevel } from "./data/chart/engines/marketUnderstandingTypes.js";

export interface ScannerEntryRoom {
  entry: number;
  target: number;
  defendedLevel: number | null;
  rewardToRisk: number;
  oneRiskEntry: number;
}

/** A live side quote and the first defended opposing level bound the room
 * available before a breakout is needed. Distances use price units. */
export function measureScannerEntryRoom(
  side: string,
  quote: { bid: number; ask: number } | undefined,
  stop: number,
  target: number,
  levels: readonly ChartLevel[],
): ScannerEntryRoom | undefined {
  if ((side !== "BUY" && side !== "SELL") || !quote || !Number.isFinite(quote.bid) ||
      !Number.isFinite(quote.ask) || quote.bid <= 0 || quote.ask < quote.bid ||
      !Number.isFinite(stop) || !Number.isFinite(target) || stop <= 0 || target <= 0) return undefined;
  const buy = side === "BUY";
  const sign = buy ? 1 : -1;
  const entry = buy ? quote.ask : quote.bid;
  const risk = sign * (entry - stop);
  const stopIntact = buy ? quote.bid > stop : quote.ask < stop;
  const targetDistance = sign * (target - entry);
  const opposingKind = buy ? "resistance" : "support";
  let first = target;
  for (const level of levels) {
    const distance = sign * (level.price - entry);
    if (level.kind === opposingKind && level.personality === "defended" && level.price > 0 &&
        distance >= 0 && distance < sign * (first - entry)) first = level.price;
  }
  return {
    entry, target: first, defendedLevel: first === target ? null : first,
    rewardToRisk: stopIntact && risk > 0 && targetDistance > 0 ? sign * (first - entry) / risk : 0,
    oneRiskEntry: (stop + first) / 2,
  };
}

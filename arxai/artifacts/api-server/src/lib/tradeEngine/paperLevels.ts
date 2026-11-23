/**
 * The protective level crossed by this mark, or null if both are still open.
 * The simulator settles at the level. Market-priced orders use the executable quote.
 */
export function crossedPaperLevel(
  o: { direction: string; stopLoss: number; takeProfit?: number | null },
  px: number,
): { level: number; hit: "SL" | "TP" } | null {
  const tp = o.takeProfit ?? null;
  if (o.direction === "BUY") {
    if (px <= o.stopLoss) return { level: o.stopLoss, hit: "SL" };
    if (tp != null && px >= tp) return { level: tp, hit: "TP" };
  } else {
    if (px >= o.stopLoss) return { level: o.stopLoss, hit: "SL" };
    if (tp != null && px <= tp) return { level: tp, hit: "TP" };
  }
  return null;
}

/** Price at which the position can be liquidated on this two-sided quote. */
export function paperExitQuote(
  direction: string,
  q: { bid: number; ask: number },
): number {
  return direction === "BUY" ? q.bid : q.ask;
}

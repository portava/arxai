// When the producer's newest tick may stand in for the newest bar's close as a
// series' current price (Truth audit, 2026-11-25).
//
// A provider's in-progress bar carries its latest close but no clock for it,
// so that close cannot be dated. The producer's tick carries both a price and
// its own time. tickPriceSupersedingClose decides, from those facts only,
// whether the tick is provably no older than the bar close. The price it
// returns is always the tick's own, so a reader that pairs it with the tick's
// time never pairs a price with a time at which that price was not observed.

export interface TickPriceFacts {
  /** The newest provider bar (never a synthesized display tip), or null. */
  bar: { openTime: string; closeTime: string; close: number; isComplete: boolean } | null;
  /** The producer's tick: its own time and its price on the bars' basis. */
  tick: { atMs: number; price: number } | null;
  /** The tick the same stream delivered just before `tick`, when known. */
  previousTick?: { atMs: number; price: number } | null;
  nowMs: number;
}

const positive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/** The tick's price when the tick is provably no older than the bar close, else null. */
export function tickPriceSupersedingClose(f: TickPriceFacts): number | null {
  const { bar, tick } = f;
  if (!bar || !tick || !Number.isFinite(tick.atMs) || tick.atMs > f.nowMs || !positive(tick.price)) return null;
  const openMs = Date.parse(bar.openTime);
  const closeMs = Date.parse(bar.closeTime);
  if (!Number.isFinite(openMs) || !Number.isFinite(closeMs) || !positive(bar.close)) return null;
  // At or after the bar's interval: newer than any price inside it.
  if (tick.atMs >= closeMs) return tick.price;
  // A closed bar's close stands at its close time; an earlier tick is older.
  if (bar.isComplete) return null;
  // Before the in-progress bar opened: older than any close it has had.
  if (tick.atMs < openMs) return null;
  // The same price as the close: that price was observed at the tick's time.
  if (tick.price === bar.close) return tick.price;
  // The close is the stream's previous tick, inside this bar: the bar is one
  // tick behind, and this tick is the next one.
  const prev = f.previousTick;
  if (prev && Number.isFinite(prev.atMs) && prev.atMs >= openMs && prev.atMs < tick.atMs && prev.price === bar.close) {
    return tick.price;
  }
  // Otherwise the order is unknown: the close may hold a tick this stream has
  // not delivered yet, so the close keeps standing.
  return null;
}

/** The quote side a bar series on `basis` is built from, or null when it is not carried. */
export function quotePriceOnBasis(
  quote: { bid?: number; ask?: number; last?: number },
  basis: string | null | undefined,
): number | null {
  if (basis === "BID") return positive(quote.bid) ? quote.bid : null;
  if (basis === "LAST") return positive(quote.last) ? quote.last : null;
  if (basis === "MID") return positive(quote.bid) && positive(quote.ask) && quote.ask >= quote.bid ? (quote.bid + quote.ask) / 2 : null;
  return null;
}

// The paper risk count of OPEN paper positions, and the risk-count equity
// built from it and the settled closes. Read-only: nothing here settles an
// order or writes a row, so the Risk Governor can call it from its fact
// loader (which also runs in preview mode) and trader readiness can call it
// from a read model.
//
// The stored paper equity (paperVenue.markToMarket) values each open position
// at its contract-sized P&L. Before contract sizing (16c8a1a0) it valued every
// open position at the paper risk model (price move × lots × 100), so a small
// contract (an index at 1 unit per lot) carried a 100× larger floating loss
// and a currency pair (100,000 units) a 1,000× smaller floating gain. The risk
// count values each open position at the LOWER of the two at the price the
// venue marks it at (tradeEngine/paperMark.ts):
//   - a simulator-priced order at the simulator's price now; a crossed stop or
//     target at that level (markToMarket settles it there);
//   - a market-priced order (Build EE, a market-priced simulated open) at the
//     quote the order is being checked with, when it is a market quote for
//     the same symbol. No other market quote is read here (no network call
//     from the governor's read path). Without one the position is counted at
//     its stop: the venue books a stop exit at the stop level, so that is the
//     most it can lose through its stop. Its symbol is reported so every
//     refusal and note that reads the figure can say so.
// The floating figure the governor reads is the lower of that total and the
// floating P&L the account stores, so it is never above the stored (booked)
// figure either.

import { getMockPrice, isMarketPricedPaperOrder, PAPER_SIMULATOR_PRICE_SOURCE, simulatorExitLevel } from "../tradeEngine/paperMark.js";
import type { ResolvedContractSize } from "../mt5/contractSize.js";
import { paperLedgerModelPnl, paperModelRealized, paperRiskShortfall, type PaperCloseFigures } from "./paperRiskCount.js";
import { resolvePaperContract, sizePaperOrderPnl } from "./paperPnl.js";

/** The fields of an open paper order its value is read from. */
export interface PaperOpenFigures {
  symbol: string;
  direction: string;
  lotSize: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit?: number | null;
  strategyId?: string | null;
  userId?: number | null;
}

/** A quote the order being checked carries, for the symbol it is for. */
export interface PaperMarkQuote {
  symbol: string;
  bid: number | null;
  ask: number | null;
  source: string;
}

export interface PaperOpenRiskValue {
  /** Σ over open positions of min(sized, price move × lots × 100) at the venue's mark. */
  total: number;
  /**
   * Σ over open positions of price move × lots × 100 at the same mark: the
   * open positions on the paper risk model alone (paperModelEquity reads it).
   */
  model: number;
  /** Symbols of the positions counted at their stop because no market quote for them was read here. */
  valuedAtStop: string[];
}

/** The price the venue marks this open order at, or null when it needs a market quote that was not given. */
function markOf(o: PaperOpenFigures, now: Date, quote: PaperMarkQuote | null): number | null {
  if (isMarketPricedPaperOrder(o)) {
    if (!quote || quote.symbol !== o.symbol || quote.source === PAPER_SIMULATOR_PRICE_SOURCE) return null;
    // markToMarket marks a BUY at the bid and a SELL at the ask.
    const px = o.direction === "BUY" ? quote.bid : quote.ask;
    return px != null && Number.isFinite(px) && px > 0 ? px : null;
  }
  const px = getMockPrice(o.symbol, now.getTime());
  return simulatorExitLevel(o, px)?.level ?? px;
}

/** Value every open position at the lower of its sized and its ×100 figure (see the header). */
export async function valueOpenPaperPositions(
  rows: readonly PaperOpenFigures[],
  opts: { now: Date; userId: number | null; quote?: PaperMarkQuote | null },
): Promise<PaperOpenRiskValue> {
  const contracts = new Map<string, Promise<ResolvedContractSize>>();
  let total = 0;
  let modelTotal = 0;
  const valuedAtStop: string[] = [];
  for (const o of rows) {
    const mark = markOf(o, opts.now, opts.quote ?? null);
    const px = mark ?? o.stopLoss;
    if (mark == null && !valuedAtStop.includes(o.symbol)) valuedAtStop.push(o.symbol);
    const owner = o.userId !== undefined ? o.userId : opts.userId;
    const key = `${owner ?? "none"}|${o.symbol}`;
    let c = contracts.get(key);
    if (!c) { c = resolvePaperContract(owner, o.symbol); contracts.set(key, c); }
    const model = paperLedgerModelPnl(o.direction, o.lotSize, o.entryPrice, px);
    const sized = (await sizePaperOrderPnl({ ...o, userId: owner }, px, await c)).amount;
    // An open position that cannot be sized counts as markToMarket stores it:
    // a loss at the model, a gain as 0.
    total += Math.min(sized ?? Math.min(0, model), model);
    modelTotal += model;
  }
  return { total, model: modelTotal, valuedAtStop };
}

/** The paper risk-count equity and the booked figures it was taken from. */
export interface PaperRiskEquity {
  /** The equity every cap is valued on. */
  equity: number;
  /** The stored (booked) equity, as shown. */
  bookedEquity: number;
  /** Open positions' floating P&L as counted: the lower of the stored figure and the open risk value. */
  floating: number;
  /** The floating P&L the account stores (equity − balance). */
  bookedFloating: number;
  /** Symbols counted at their stop (see PaperOpenRiskValue); empty when the stored figure was the lower one. */
  openValuedAtStop: string[];
}

/**
 * The equity the Risk Governor values every paper cap on: the booked equity,
 * lowered to the lower of the booked and ×100 totals of every settled close
 * (paperRiskShortfall), and with the open positions' floating P&L replaced by
 * the open risk value when that is lower. Never above the booked equity, and
 * never above the equity the same closes and open positions give at the ×100
 * model at the venue's mark.
 */
export function paperRiskEquity(
  acct: { equity: number; currentBalance: number },
  closes: readonly PaperCloseFigures[],
  open: PaperOpenRiskValue,
): PaperRiskEquity {
  const bookedFloating = acct.equity - acct.currentBalance;
  const floating = Math.min(bookedFloating, open.total);
  return {
    equity: acct.equity + paperRiskShortfall(closes) + (floating - bookedFloating),
    bookedEquity: acct.equity,
    floating,
    bookedFloating,
    openValuedAtStop: floating < bookedFloating ? open.valuedAtStop : [],
  };
}

/**
 * The account's equity on the paper risk model alone (price move × lots ×
 * 100, quoted 1:1 in USD), and its peak on the same basis, for the Risk
 * Governor's drawdown rule. Read-only: nothing is stored.
 *   - equity: the starting balance, plus every settled close at the model
 *     (paperModelRealized), plus each open position at the model at the
 *     venue's mark (PaperOpenRiskValue.model; a position with no market quote
 *     for it is counted at its stop and named in openValuedAtStop);
 *   - peak: the highest of the starting balance, the equity after each
 *     settled close in close order (no open positions are recorded between
 *     closes, so a gain an open position showed in the past is not in it),
 *     and the equity now.
 * The booked basis is the paper account's own equity against the peak the
 * governor records from it (user_equity_peaks).
 */
export interface PaperModelEquity {
  equity: number;
  peakEquity: number;
  /** When the peak was reached: a close's time, `now` for the equity now, null for the starting balance. */
  peakAt: Date | null;
  /** Open positions counted at their stop in `equity` (no market quote for them was read). */
  openValuedAtStop: string[];
}

export function paperModelEquity(
  acct: { startingBalance: number },
  closes: ReadonlyArray<PaperCloseFigures & { closedAt: Date; id?: number }>,
  open: PaperOpenRiskValue,
  now: Date,
): PaperModelEquity {
  const ordered = [...closes].sort((a, b) => a.closedAt.getTime() - b.closedAt.getTime() || (a.id ?? 0) - (b.id ?? 0));
  let running = acct.startingBalance;
  let peakEquity = running;
  let peakAt: Date | null = null;
  for (const c of ordered) {
    running += paperModelRealized(c);
    if (running > peakEquity) { peakEquity = running; peakAt = c.closedAt; }
  }
  const equity = running + open.model;
  if (equity > peakEquity) { peakEquity = equity; peakAt = now; }
  return { equity, peakEquity, peakAt, openValuedAtStop: [...open.valuedAtStop] };
}

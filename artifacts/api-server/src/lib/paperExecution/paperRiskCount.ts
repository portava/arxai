// The paper risk model and the paper book's realized-P/L counts, with no
// database or contract lookups, so a route or view can count a paper close
// the way the risk readers do without loading the contract-size resolver.
// paperPnl.ts re-exports everything here.

/**
 * Contract size of the Risk Governor's paper ledger model
 * (riskGovernor/enforce.ts PAPER_LEDGER_INSTRUMENT): every paper symbol at
 * 100 units per lot, quoted 1:1 in USD. It is the size the governor priced a
 * paper order's loss at stop with when it allowed it, and the size the paper
 * book held for every order before contract sizing.
 */
export const PAPER_LEDGER_MODEL_CONTRACT_SIZE = 100;

/**
 * P&L at the governor's paper ledger model: direction × move × lots × 100.
 * A risk figure for an amount that could not be sized, never a measured
 * result and never shown as one.
 */
export function paperLedgerModelPnl(direction: string, lots: number, entry: number, price: number): number {
  return (direction === "SELL" ? -1 : 1) * (price - entry) * lots * PAPER_LEDGER_MODEL_CONTRACT_SIZE;
}

/**
 * True when a settled order's stored P&L is the not-sized placeholder.
 * paper_orders.profit_loss cannot be empty, so a close whose amount could not
 * be sized stores 0. A 0 on an exit that moved away from entry is that
 * placeholder, not a breakeven (the paper history reads it "not sized" by the
 * same rule). A 0 on a flat exit is a real breakeven.
 */
export function isUnsizedPaperClose(o: { profitLoss: number | null; entryPrice: number; exitPrice: number | null }): boolean {
  return o.profitLoss === 0 && o.exitPrice != null && o.exitPrice !== o.entryPrice;
}

/** The fields of a settled paper order that its realized P/L is read from. */
export interface PaperCloseFigures {
  profitLoss: number | null;
  exitPrice: number | null;
  entryPrice: number;
  direction: string;
  lotSize: number;
}

/**
 * Booked P/L of one settled paper order: the figure the paper account's
 * balance adds up (tradeEngine/paperVenue.markToMarket). The stored
 * profit_loss when it is a sized amount. An amount that could not be sized
 * (the 0 placeholder on an exit that moved from entry, see
 * isUnsizedPaperClose) or that has no recorded profit_loss counts only when
 * it lost, at the paper risk model (move × lots × 100) signed by the fills; a
 * win of unknown size counts 0.
 */
export function paperBookedRealized(o: PaperCloseFigures): number {
  if (o.profitLoss != null && !isUnsizedPaperClose(o)) return Number(o.profitLoss);
  if (o.exitPrice == null) return 0;
  const model = paperLedgerModelPnl(o.direction, Math.abs(o.lotSize || 1), o.entryPrice, o.exitPrice);
  return model < 0 ? model : 0;
}

/**
 * Realized P/L of one settled paper order as a RISK input (daily and weekly
 * loss totals, the autopilot's daily stop, the equity the Risk Governor caps
 * against): the lower of its booked amount (paperBookedRealized) and the paper
 * risk model (move × lots × 100), the figure every paper close was counted at
 * before the venue sized P&L at the instrument's contract size. A loss booked
 * smaller than the model (a broker contract under 100 units, e.g. an index)
 * still counts at the model, and a win booked larger than the model (a
 * currency pair at 100,000 units) counts only at the model, so no risk count
 * is ever looser than either figure. Its sign is the booked amount's sign, so
 * a losing streak reads the same. A risk count, not a measured result: the
 * booked amount stays the figure shown as P&L.
 */
export function paperRiskRealized(o: PaperCloseFigures): number {
  const booked = paperBookedRealized(o);
  if (o.exitPrice == null) return booked;
  return Math.min(booked, paperLedgerModelPnl(o.direction, Math.abs(o.lotSize || 1), o.entryPrice, o.exitPrice));
}

/**
 * How far the risk count of these settled orders falls below their booked
 * P/L: Σ (paperRiskRealized − paperBookedRealized). Always 0 or less. The Risk
 * Governor lowers the booked paper equity by it before checking a cap.
 */
export function paperRiskShortfall(rows: readonly PaperCloseFigures[]): number {
  return rows.reduce((s, o) => s + (paperRiskRealized(o) - paperBookedRealized(o)), 0);
}

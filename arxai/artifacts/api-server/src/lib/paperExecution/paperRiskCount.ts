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
 * The x100 model figure of one settled paper order: move × lots × 100 signed
 * by the fills (paperLedgerModelPnl), the figure every paper close was counted
 * at before the venue sized P&L at the instrument's contract size (16c8a1a0).
 * A row with no exit price has no move to price, so its booked figure stands
 * (16c8a1a0 read the stored figure for it too).
 */
export function paperModelRealized(o: PaperCloseFigures): number {
  if (o.exitPrice == null) return paperBookedRealized(o);
  return paperLedgerModelPnl(o.direction, Math.abs(o.lotSize || 1), o.entryPrice, o.exitPrice);
}

/** The two full bases of a set of settled paper orders, and the risk count taken from them. */
export interface PaperRiskTotals {
  /** Σ paperBookedRealized: the figure the paper balance adds up. */
  booked: number;
  /** Σ paperModelRealized: the figure 16c8a1a0 counted the same closes at. */
  model: number;
  /** The lower of the two totals. */
  risk: number;
}

/**
 * The paper risk count of a set of settled orders (today's closes, the week's,
 * every close on the account): the LOWER OF TWO FULL TOTALS over the same
 * closes, the booked total and the x100 model total. It is never above either
 * total and always equals one of them, so it can never drift below both. A
 * risk input (the Risk Governor's daily loss total, weekly P/L and the equity
 * every cap is valued on, the autopilot's daily stop, trader readiness, the
 * risk overview) reads this, never a sum of per-close figures: a sum of
 * per-close minimums takes every win at the smaller figure and every loss at
 * the larger one, so it falls below both totals and keeps falling.
 */
export function paperRiskTotals(rows: readonly PaperCloseFigures[]): PaperRiskTotals {
  let booked = 0;
  let model = 0;
  for (const o of rows) {
    booked += paperBookedRealized(o);
    model += paperModelRealized(o);
  }
  return { booked, model, risk: Math.min(booked, model) };
}

/**
 * The paper risk count of ONE settled order: the lower of its booked figure
 * and its x100 model figure (paperRiskTotals over that one close). Its sign is
 * the sign of its move whenever it was sized, so a losing streak reads each
 * close by it. Never add these up for a total over several closes: use
 * paperRiskTotals (see there why).
 */
export function paperRiskRealized(o: PaperCloseFigures): number {
  return paperRiskTotals([o]).risk;
}

/**
 * How far the risk count of these settled orders falls below their booked
 * total: min(0, Σ model − Σ booked), i.e. paperRiskTotals(rows).risk − booked.
 * Always 0 or less. The Risk Governor lowers the booked paper equity by it
 * (over every settled order on the account) before checking a cap, so that
 * equity is never above the booked equity nor above the equity the same
 * closes gave when every close was counted at the x100 model.
 */
export function paperRiskShortfall(rows: readonly PaperCloseFigures[]): number {
  const t = paperRiskTotals(rows);
  return t.risk - t.booked;
}

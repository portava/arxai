// Contract-size-aware paper P&L: the one sizing rule for every paper order,
// used by the Build EE monitor and by every PAPER venue path (mark-to-market,
// the trader's close, the EE manual close, stop/target settlement).
//
// The monitor used `direction × move × lots × 100` for every symbol, so a
// 1.00-lot, 100-pip EURUSD winner read 1.00 instead of 1,000 and a V75 or gold
// position was mis-sized by orders of magnitude. This reuses the realized-P/L
// sizing rule in mt5/contractSize.ts:
//
//   pnl = (price − entry) × direction × lots × contractSize × quoteToAccountFx
//
// Paper accounts are USD-denominated. When the contract size or the FX factor
// cannot be established the amount is null WITH a plain-English reason — never
// a plausible-looking guess.

import {
  computeRealizedAmount,
  decideContractSize,
  resolveContractSize,
  resolveQuoteToAccountFx,
  type ResolvedContractSize,
} from "../mt5/contractSize.js";

export const PAPER_ACCOUNT_CURRENCY = "USD";

export interface PaperPnlResult {
  /** P&L in the paper account currency, rounded to cents; null = not sized. */
  amount: number | null;
  /** Why amount is null; null when it was sized. */
  unavailableReason: string | null;
}

/** Sign of the price move in the trade's favour: 1 win, -1 loss, 0 flat. */
export function paperMoveSign(direction: string, entry: number, price: number): 1 | -1 | 0 {
  const move = (direction === "BUY" ? 1 : -1) * (price - entry);
  return move > 0 ? 1 : move < 0 ? -1 : 0;
}

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

export function paperPnl(a: {
  symbol: string;
  direction: string;
  lots: number;
  entry: number;
  price: number;
  /** Broker-reported spec when known; otherwise only a fiat FX pair is sizable. */
  contract?: ResolvedContractSize;
  accountCurrency?: string;
}): PaperPnlResult {
  const contract = a.contract ?? decideContractSize({
    symbol: a.symbol, brokerContractSize: null, brokerProfitCurrency: null,
  });
  if (contract.contractSize == null) {
    return {
      amount: null,
      unavailableReason: contract.reason === "BROKER_SPEC_INVALID"
        ? `contract size for ${a.symbol} reported by the broker is invalid`
        : `contract size for ${a.symbol} is unknown (no broker symbol spec and not a currency pair)`,
    };
  }
  const fx = resolveQuoteToAccountFx({
    symbol: a.symbol,
    profitCurrency: contract.profitCurrency,
    accountCurrency: a.accountCurrency ?? PAPER_ACCOUNT_CURRENCY,
    closePrice: a.price,
  });
  if (fx.factor == null) {
    return {
      amount: null,
      unavailableReason: `no ${contract.profitCurrency ?? "profit-currency"}→${a.accountCurrency ?? PAPER_ACCOUNT_CURRENCY} rate to convert ${a.symbol} P&L`,
    };
  }
  const amount = computeRealizedAmount({
    entryPrice: a.entry,
    closePrice: a.price,
    direction: a.direction === "BUY" ? 1 : -1,
    lots: a.lots,
    contractSize: contract.contractSize,
    quoteToAccountFx: fx.factor,
  });
  return { amount: Number(amount.toFixed(2)), unavailableReason: null };
}

/**
 * Contract size for a paper order: the owner's broker-reported spec when one
 * exists, else the FX standard lot for a fiat pair, else unknown. An ownerless
 * order, or a spec read that fails, falls back to the no-spec decision.
 */
export async function resolvePaperContract(userId: number | null, symbol: string): Promise<ResolvedContractSize> {
  const noSpec = decideContractSize({ symbol, brokerContractSize: null, brokerProfitCurrency: null });
  if (userId == null) return noSpec;
  try {
    return await resolveContractSize(userId, symbol);
  } catch {
    return noSpec;
  }
}

/** P&L of a paper order at `price`, sized at its contract size (null amount + reason when it cannot be). */
export async function sizePaperOrderPnl(
  o: { userId: number | null; symbol: string; direction: string; lotSize: number; entryPrice: number },
  price: number,
  contract?: ResolvedContractSize,
): Promise<PaperPnlResult> {
  return paperPnl({
    symbol: o.symbol, direction: o.direction, lots: o.lotSize, entry: o.entryPrice, price,
    contract: contract ?? await resolvePaperContract(o.userId, o.symbol),
  });
}

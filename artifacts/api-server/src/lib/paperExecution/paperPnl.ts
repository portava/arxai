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

// Contract-size-aware paper P&L (Build EE monitor).
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

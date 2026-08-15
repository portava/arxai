// P0-2 — Contract-size and quote→account FX resolution for realized P/L.
//
// WHY THIS MODULE EXISTS
//
// Realized P/L was computed as `(close − entry) × direction × lots`, with NO
// contract size. For EURUSD that is wrong by a factor of 100,000: a 1.00-lot,
// 100-pip winner booked $0.01 instead of $1,000.
//
// That number is not cosmetic. It feeds `virtual_trading_accounts.virtualPnl`,
// which feeds the investor USD equity readout AND the allocation-blown risk cap
// (`virtualPnl <= -virtualBalance`). Understated 100,000×, that cap could never
// trip for FX — a trader could blow the whole allocation and the CLOSE-ONLY
// brake would never engage.
//
// THE SIZING RULE
//
//   realized = (close − entry) × direction × lots × contractSize × quoteToAccountFx
//
// - `contractSize` is per-symbol broker truth (`arx_symbol_specs.contractSize`,
//   reported by the EA). 100,000 for a standard FX lot, 100 for gold, 5,000 for
//   silver, 1 for many crypto/index CFDs. It is NOT a constant.
// - `quoteToAccountFx` converts P/L (denominated in the symbol's PROFIT
//   currency) into the account currency.
//
// WHY THE STRICT ISO-4217 CLASSIFIER
//
// A loose `/^[A-Z]{6}$/` test calls XAUUSD, XAGUSD and BTCUSD "forex" and
// applies the 100,000-unit FX lot to them — mis-sizing gold by 1,000× and
// silver by 20×. BOTH halves of the symbol must be real ISO-4217 fiat codes
// before the FX standard lot may be assumed. This classifier was previously
// inlined in `routes/meLiveAccount.ts` for exactly this reason; it now lives
// here so there is a single definition and the two cannot drift.
//
// HONESTY CONTRACT (default-deny)
//
// When contract size or the FX factor cannot be established, this module
// returns `null` WITH a reason. It NEVER falls back to a plausible-looking
// number. Callers must withhold the figure ("pending correct sizing") or fail
// the safety check closed — never book a wrong dollar amount.

import { and, eq } from "drizzle-orm";
import { db, arxSymbolSpecsTable } from "@workspace/db";

/**
 * ISO-4217 fiat codes ARX trades or quotes against. Deliberately a fixed
 * allowlist: metals (XAU/XAG/XPT/XPD), crypto (BTC/ETH/…) and index tickers
 * must NOT be in here, or they inherit the 100,000-unit FX lot.
 */
export const FIAT_CODES: ReadonlySet<string> = new Set([
  "USD", "EUR", "GBP", "JPY", "AUD", "NZD", "CAD", "CHF", "SEK", "NOK", "DKK",
  "SGD", "HKD", "ZAR", "MXN", "PLN", "TRY", "CZK", "HUF", "CNH", "CNY", "RUB",
  "INR", "THB", "ILS", "KRW",
]);

/** The standard FX lot: 100,000 units of the base currency. */
export const FX_STANDARD_LOT_UNITS = 100_000;

/**
 * Split a symbol into ISO-4217 base/quote, tolerating a broker suffix
 * (`EURUSD.raw`, `EURUSD_i`, `EURUSD-ECN`). Returns null unless BOTH halves are
 * real fiat codes — so XAUUSD, BTCUSD and US30 all return null.
 */
export function splitForexPair(symbol: string): { base: string; quote: string } | null {
  const m = /^([A-Z]{3})([A-Z]{3})([._-][A-Z0-9]+)?$/.exec(symbol.trim().toUpperCase());
  if (!m) return null;
  const base = m[1]!;
  const quote = m[2]!;
  if (!FIAT_CODES.has(base) || !FIAT_CODES.has(quote)) return null;
  return { base, quote };
}

/** Strict forex classifier: BOTH halves must be ISO-4217 fiat currency codes. */
export function isForexPair(symbol: string): boolean {
  return splitForexPair(symbol) != null;
}

export type ContractSizeSource = "BROKER_SPEC" | "FX_STANDARD_LOT";

export interface ResolvedContractSize {
  /** Units of the base instrument per 1.00 lot. null = unknown; do NOT guess. */
  contractSize: number | null;
  source: ContractSizeSource | null;
  /** Machine-readable reason when contractSize is null. */
  reason: "NO_BROKER_SPEC_AND_NOT_FOREX" | "BROKER_SPEC_INVALID" | null;
  /** The symbol's profit currency (broker truth, else the pair's quote half). */
  profitCurrency: string | null;
}

/**
 * PURE decision half of contract-size resolution — the DB read is separated so
 * every branch is unit-testable without a database.
 *
 * Order of authority:
 *   1. Broker truth (`arx_symbol_specs.contractSize`), when present and valid.
 *   2. For a STRICT ISO-4217 fiat pair only, the 100,000-unit FX standard lot.
 *   3. Otherwise null — gold, silver, crypto, indices and anything unrecognised
 *      have no trustworthy default, so we refuse to invent one.
 */
export function decideContractSize(args: {
  symbol: string;
  brokerContractSize: number | null;
  brokerProfitCurrency: string | null;
}): ResolvedContractSize {
  const profitCurrency = args.brokerProfitCurrency ?? null;

  if (args.brokerContractSize != null) {
    if (!Number.isFinite(args.brokerContractSize) || args.brokerContractSize <= 0) {
      return { contractSize: null, source: null, reason: "BROKER_SPEC_INVALID", profitCurrency };
    }
    return {
      contractSize: args.brokerContractSize,
      source: "BROKER_SPEC",
      reason: null,
      profitCurrency,
    };
  }

  const pair = splitForexPair(args.symbol);
  if (pair) {
    return {
      contractSize: FX_STANDARD_LOT_UNITS,
      source: "FX_STANDARD_LOT",
      reason: null,
      // With no broker row, a fiat pair's profit currency IS its quote currency.
      profitCurrency: profitCurrency ?? pair.quote,
    };
  }

  return { contractSize: null, source: null, reason: "NO_BROKER_SPEC_AND_NOT_FOREX", profitCurrency };
}

/**
 * Resolve the per-lot contract size for one user+symbol, reading the EA-reported
 * broker spec first. Thin DB wrapper around `decideContractSize`.
 */
export async function resolveContractSize(
  userId: number,
  symbol: string,
): Promise<ResolvedContractSize> {
  const rows = await db.select({
    contractSize: arxSymbolSpecsTable.contractSize,
    profitCurrency: arxSymbolSpecsTable.profitCurrency,
  }).from(arxSymbolSpecsTable)
    .where(and(eq(arxSymbolSpecsTable.userId, userId), eq(arxSymbolSpecsTable.symbol, symbol)))
    .limit(1);
  const row = rows[0];
  return decideContractSize({
    symbol,
    brokerContractSize: row?.contractSize ?? null,
    brokerProfitCurrency: row?.profitCurrency ?? null,
  });
}

export type QuoteFxSource = "SAME_CURRENCY" | "INVERSE_QUOTE";

export interface ResolvedQuoteFx {
  /** Multiply P/L (in profit currency) by this to get account currency. */
  factor: number | null;
  source: QuoteFxSource | null;
  reason: "NO_CROSS_RATE_AVAILABLE" | "INVALID_PRICE" | null;
}

/**
 * Resolve the profit-currency → account-currency conversion factor.
 *
 * P/L on a BASE/QUOTE symbol is denominated in QUOTE. Two cases can be
 * established honestly from data we already hold:
 *
 *   - QUOTE === account currency (EURUSD on a USD account)  → 1
 *   - BASE  === account currency (USDJPY on a USD account)  → 1 / price,
 *     because 1 unit of account currency buys `price` units of quote currency.
 *
 * Anything else (EURGBP on a USD account) needs a third-currency cross rate we
 * do not hold here. Return null so the caller withholds the figure rather than
 * booking a wrong one.
 *
 * `price` is the CLOSE price of the trade — the rate at which the P/L
 * crystallised.
 */
export function resolveQuoteToAccountFx(args: {
  symbol: string;
  profitCurrency: string | null;
  accountCurrency: string;
  closePrice: number;
}): ResolvedQuoteFx {
  const account = args.accountCurrency.trim().toUpperCase();
  const pair = splitForexPair(args.symbol);
  // Broker truth first; fall back to the pair's quote half for a fiat pair.
  const profit = (args.profitCurrency ?? pair?.quote ?? "").trim().toUpperCase();

  if (!profit || !account) return { factor: null, source: null, reason: "NO_CROSS_RATE_AVAILABLE" };
  if (profit === account) return { factor: 1, source: "SAME_CURRENCY", reason: null };

  if (!Number.isFinite(args.closePrice) || args.closePrice <= 0) {
    return { factor: null, source: null, reason: "INVALID_PRICE" };
  }

  // USDJPY on a USD account: P/L is in JPY and BASE is the account currency.
  if (pair && pair.base === account && pair.quote === profit) {
    return { factor: 1 / args.closePrice, source: "INVERSE_QUOTE", reason: null };
  }

  return { factor: null, source: null, reason: "NO_CROSS_RATE_AVAILABLE" };
}

/**
 * The canonical realized-P/L amount, in ACCOUNT currency.
 *
 * Pure, and deliberately without fallbacks: every input must already be
 * established, so a missing contract size cannot silently become 1.
 */
export function computeRealizedAmount(args: {
  entryPrice: number;
  closePrice: number;
  direction: 1 | -1;
  lots: number;
  contractSize: number;
  quoteToAccountFx: number;
}): number {
  const gross =
    (args.closePrice - args.entryPrice) *
    args.direction *
    args.lots *
    args.contractSize *
    args.quoteToAccountFx;
  return Number(gross.toFixed(8));
}

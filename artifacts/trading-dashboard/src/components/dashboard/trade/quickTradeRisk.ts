// Quick Trade "Risk approx." readout (Trade Command Room).
//
// Display only: the server's risk governor remains the authority on submit.
// Never fabricates a number: returns a plain reason instead of a dollar figure
// whenever an input it needs is missing or cannot be trusted.

import { isMarketQuote, type Quote } from "./QuickTradePanel";

// Mirrors the server's default-deny contract-size policy
// (api-server/src/lib/mt5/contractSize.ts): the 100,000-unit FX lot may only
// be assumed when BOTH halves of the symbol are ISO-4217 fiat codes. Metals,
// crypto, indices and synthetics have broker-specific contract sizes this
// panel does not know, so no figure is shown for them.
const FIAT_CODES: ReadonlySet<string> = new Set([
  "USD", "EUR", "GBP", "JPY", "AUD", "NZD", "CAD", "CHF", "SEK", "NOK", "DKK",
  "SGD", "HKD", "ZAR", "MXN", "PLN", "TRY", "CZK", "HUF", "CNH", "CNY", "RUB",
  "INR", "THB", "ILS", "KRW",
]);
const FX_STANDARD_LOT_UNITS = 100_000;

function splitForexPair(symbol: string): { base: string; quote: string } | null {
  const bare = symbol.includes(":") ? symbol.slice(symbol.lastIndexOf(":") + 1) : symbol;
  const m = /^([A-Z]{3})([A-Z]{3})([._-][A-Z0-9]+)?$/.exec(bare.trim().toUpperCase());
  if (!m) return null;
  const base = m[1]!;
  const quote = m[2]!;
  if (!FIAT_CODES.has(base) || !FIAT_CODES.has(quote)) return null;
  return { base, quote };
}

export function quickTradeRiskApprox(input: {
  symbol: string; lot: string; stopLoss: string; quote: Quote;
}): string {
  const { symbol, lot, stopLoss, quote } = input;
  const l = Number(lot) || 0;
  const sl = Number(stopLoss);
  if (!l) return "—";
  // Only a market quote may anchor the stop distance; the simulator quote
  // (/api/market/quote) is synthetic, so no dollar figure is derived from it.
  if (!isMarketQuote(quote)) return "No market price";
  const ref = quote.mid ?? quote.bid ?? quote.ask;
  if (!stopLoss || !Number.isFinite(sl) || !Number.isFinite(ref) || sl <= 0) {
    return "Set SL";
  }
  // Risk in the quote currency = lots × contract units × stop distance; it is
  // shown in USD only when it is USD already (XXXUSD) or converts with the
  // pair's own price (USDXXX). A cross pair would need another rate.
  const pair = splitForexPair(symbol);
  if (!pair) return "Contract size unknown";
  const riskInQuoteCcy = l * FX_STANDARD_LOT_UNITS * Math.abs(ref - sl);
  let risk: number;
  if (pair.quote === "USD") risk = riskInQuoteCcy;
  else if (pair.base === "USD") risk = riskInQuoteCcy / ref;
  else return `Needs ${pair.quote}→USD rate`;
  if (!Number.isFinite(risk) || risk <= 0) return "—";
  return `$${risk.toFixed(2)}`;
}

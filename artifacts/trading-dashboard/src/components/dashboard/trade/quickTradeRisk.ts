// Quick Trade "Risk approx." readout (Trade Command Room).
//
// Display only: the server's risk governor remains the authority on submit.
// Never fabricates a number: returns a plain reason instead of a dollar figure
// whenever an input it needs is missing or cannot be trusted.

import { isMarketQuote, type Quote } from "./QuickTradePanel";

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
  //   risk ≈ lots × stop-distance(in pips) × pip-value-per-lot
  const isJpy = /JPY$/i.test(symbol);
  const pipSize = isJpy ? 0.01 : 0.0001;
  const pips = Math.abs(ref - sl) / pipSize;
  const pipValuePerLot = 10; // ~$10 per pip per 1.0 standard lot
  const risk = l * pips * pipValuePerLot;
  if (!Number.isFinite(risk) || risk <= 0) return "—";
  return `$${risk.toFixed(2)}`;
}

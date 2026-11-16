// Shared real-quote admission for market-priced PAPER opens and closes.
//
// ONE execution price source (owner decision 2026-11-04, audit H4): the market
// data router, which is what the Risk Governor (`loadQuote`), the chart and the
// decision engine read. The venue therefore fills on the price the governor
// sized on. The older `marketDataService` path is no longer an execution price.
import { routeQuote } from "../data/marketDataRouter.js";
import { isMockQuoteProvider, EXECUTION_PRICE_SOURCE } from "../riskGovernor/enforce.js";

/** Older than this, a quote is not a current execution price (same bound the market-data blockers used). */
export const MAX_EXECUTION_QUOTE_AGE_MS = 60_000;

/** A current, real quote for the symbol, or the reasons there is none. */
export async function currentQuote(symbol: string): Promise<
  { ok: true; bid: number; ask: number; at: Date; source: string } | { ok: false; reasons: string[] }
> {
  let r: Awaited<ReturnType<typeof routeQuote>>;
  try {
    r = await routeQuote(symbol);
  } catch (err) {
    return { ok: false, reasons: [`market data unavailable: ${String(err).slice(0, 120)}`] };
  }
  const reasons: string[] = [];
  if (!r.ok || !r.quote) {
    reasons.push(r.userMessage || "no live quote from any provider");
    return { ok: false, reasons };
  }
  const q = r.quote;
  if (isMockQuoteProvider(r.primaryProvider)) reasons.push(`price source is ${r.primaryProvider}, not a real provider`);
  const bid = typeof q.bid === "number" ? q.bid : NaN;
  const ask = typeof q.ask === "number" ? q.ask : NaN;
  const at = new Date(q.timestamp);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) reasons.push("no valid bid/ask");
  if (!Number.isFinite(at.getTime()) || at.getTime() > Date.now()) reasons.push("quote has no valid observation time");
  else if (Date.now() - at.getTime() > MAX_EXECUTION_QUOTE_AGE_MS) reasons.push(`Stale quote: ${Math.round((Date.now() - at.getTime()) / 1000)}s old (max ${MAX_EXECUTION_QUOTE_AGE_MS / 1000}s)`);
  if (bid > ask) reasons.push("crossed bid/ask");
  if (reasons.length) return { ok: false, reasons: [...new Set(reasons)] };
  return { ok: true, bid, ask, at, source: `${EXECUTION_PRICE_SOURCE}:${r.primaryProvider ?? "unknown"}` };
}

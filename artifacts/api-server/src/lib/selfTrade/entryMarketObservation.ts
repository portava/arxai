// Gathers the market facts an agent entry is re-checked against at the final
// dispatch claim. Runs OUTSIDE any database lock and never throws: a read failure
// becomes an `error` observation that the claim refuses (fail closed).
//
// Quote: the existing router (`routeQuote`, execution-broker feed first) — the
// same source the decision engine and executor already read. Its `timestamp` is
// the source observation time (broker tick time / provider asOf), not fetch time.
// Point: the broker's own SYMBOL_POINT from arx_symbol_specs, to measure spread
// and deviation in broker points like the EA pre-trade guard does.
import { routeQuote } from "../data/marketDataRouter.js";
import { getBrokerSymbolSpec } from "../mt5/brokerSymbolSpec.js";
import type { EntryMarketObservation } from "./freshFacts.js";

export async function observeAgentEntryMarket(
  userId: number,
  symbol: string,
): Promise<EntryMarketObservation> {
  const [quote, spec] = await Promise.all([
    routeQuote(symbol).catch((err: unknown) => ({ error: err })),
    getBrokerSymbolSpec(userId, symbol).catch((err: unknown) => ({ error: err })),
  ]);
  const point =
    "error" in spec ? null : spec.hasBrokerTruth ? spec.spec.point : null;
  if ("error" in quote || !quote.ok || !quote.quote)
    return {
      bid: null,
      ask: null,
      observedAt: null,
      source: "error" in quote ? null : quote.primaryProvider,
      point,
      error: "error" in quote ? "QUOTE_READ_FAILED" : "QUOTE_UNAVAILABLE",
    };
  return {
    bid: quote.quote.bid ?? null,
    ask: quote.quote.ask ?? null,
    observedAt: quote.quote.timestamp ?? null,
    source: quote.primaryProvider,
    point,
    ...("error" in spec ? { error: "BROKER_SPEC_READ_FAILED" } : {}),
  };
}

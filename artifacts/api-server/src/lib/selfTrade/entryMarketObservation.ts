// Gathers the market facts an agent entry is re-checked against at the final
// dispatch claim. Runs OUTSIDE any database lock and never throws: a read failure
// becomes an `error` observation that the claim refuses (fail closed).
//
// Quote: the execution broker's own feed only (the EA-pushed mt5_broker quote
// store; in memory, no network). Third-party quotes are not execution prices and
// the broker-confirmed-feed gate already requires this feed for entries. The
// quote's `timestamp` is its EA observation time (UTC): the EA's own `TimeGMT`
// clock stamped on the bridge v2 envelope in the same call that read the tick
// (bridgeV2/ingest.ts feedMarketDataStore). The EA's `brokerTimeEpochMs` is the
// trade server's wall clock, not UTC, and is carried only as a diagnostic offset.
// The store's priceless "not available" placeholder carries a fabricated
// now-timestamp, so it is never passed on.
// Point: the broker's own SYMBOL_POINT from arx_symbol_specs, to measure spread
// and deviation in broker points like the EA pre-trade guard does.
// Symbol: the EA quotes and reports specs under the broker's exact Market Watch
// name ("EURUSD.r", "Volatility 75 Index"), while the command row carries the
// ARX-internal name. Both reads use the same resolver the transport applies when
// the command leaves for the EA (liveCommandPipeline → resolveBrokerSymbolName),
// then match exactly: no case-folding, suffix guessing or alias invention here.
import { mt5Provider } from "../data/providers/mt5Provider.js";
import { resolveBrokerSymbolName } from "../instruments/brokerSymbolName.js";
import { getBrokerSymbolSpec } from "../mt5/brokerSymbolSpec.js";
import type { EntryMarketObservation } from "./freshFacts.js";

export const ENTRY_QUOTE_SOURCE = "mt5_broker";

export async function observeAgentEntryMarket(
  userId: number,
  symbol: string,
): Promise<EntryMarketObservation> {
  const unavailable = (
    error: string,
    brokerSymbol: string | null,
    point: unknown = null,
  ): EntryMarketObservation => ({
    bid: null,
    ask: null,
    observedAt: null,
    source: ENTRY_QUOTE_SOURCE,
    point,
    error,
    requestedSymbol: symbol,
    brokerSymbol,
  });
  let brokerSymbol: string;
  try {
    brokerSymbol = await resolveBrokerSymbolName(symbol);
  } catch {
    return unavailable("BROKER_SYMBOL_RESOLVE_FAILED", null);
  }
  const [quote, spec] = await Promise.all([
    mt5Provider.getQuote(brokerSymbol).catch((err: unknown) => ({ error: err })),
    getBrokerSymbolSpec(userId, brokerSymbol).catch((err: unknown) => ({ error: err })),
  ]);
  const point =
    "error" in spec ? null : spec.hasBrokerTruth ? spec.spec.point : null;
  if ("error" in quote || (quote.bid == null && quote.ask == null))
    return unavailable(
      "error" in quote ? "BROKER_QUOTE_READ_FAILED" : "BROKER_QUOTE_UNAVAILABLE",
      brokerSymbol,
      point,
    );
  return {
    bid: quote.bid ?? null,
    ask: quote.ask ?? null,
    observedAt: quote.timestamp ?? null,
    source: ENTRY_QUOTE_SOURCE,
    point,
    brokerClockOffsetMs:
      typeof quote.brokerClockOffsetMs === "number" && Number.isFinite(quote.brokerClockOffsetMs)
        ? quote.brokerClockOffsetMs
        : null,
    requestedSymbol: symbol,
    brokerSymbol,
    ...("error" in spec ? { error: "BROKER_SPEC_READ_FAILED" } : {}),
  };
}

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
// Bridge: the quote store is partitioned by the bridge connection that pushed
// the tick. With a dispatch context the observer reads ONLY the dispatch bridge's
// partition, so another user's EA quoting the same symbol can never supply this
// user's quote fact; a context without a bridge identity refuses. Without a
// context (legacy/unit callers) the unscoped most-recent-writer read is used.
import { mt5Provider, readMt5Quote } from "../data/providers/mt5Provider.js";
import { resolveBrokerSymbolName } from "../instruments/brokerSymbolName.js";
import { getBrokerSymbolSpec } from "../mt5/brokerSymbolSpec.js";
import type { EntryMarketObservation } from "./freshFacts.js";
import type { MarketQuote } from "../data/types.js";

export const ENTRY_QUOTE_SOURCE = "mt5_broker";

export interface EntryObservationContext {
  /** The bridge the command is being dispatched to (dispatchLiveCommand's `bridge.id`). */
  bridgeConnectionId: number | null | undefined;
}

export async function observeAgentEntryMarket(
  userId: number,
  symbol: string,
  context?: EntryObservationContext,
): Promise<EntryMarketObservation> {
  const bridgeConnectionId =
    typeof context?.bridgeConnectionId === "number" && Number.isFinite(context.bridgeConnectionId)
      ? context.bridgeConnectionId
      : null;
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
    bridgeConnectionId,
  });
  if (context !== undefined && bridgeConnectionId == null)
    return unavailable("BROKER_QUOTE_BRIDGE_UNKNOWN", null);
  let brokerSymbol: string;
  try {
    brokerSymbol = await resolveBrokerSymbolName(symbol);
  } catch {
    return unavailable("BROKER_SYMBOL_RESOLVE_FAILED", null);
  }
  const readQuote = async (): Promise<MarketQuote | null> =>
    bridgeConnectionId == null
      ? mt5Provider.getQuote(brokerSymbol)
      : readMt5Quote(brokerSymbol, { bridgeConnectionId }).quote;
  const [quote, spec] = await Promise.all([
    readQuote().catch((err: unknown) => ({ error: err })),
    getBrokerSymbolSpec(userId, brokerSymbol).catch((err: unknown) => ({ error: err })),
  ]);
  const point =
    "error" in spec ? null : spec.hasBrokerTruth ? spec.spec.point : null;
  if (quote == null || "error" in quote || (quote.bid == null && quote.ask == null))
    return unavailable(
      quote != null && "error" in quote ? "BROKER_QUOTE_READ_FAILED" : "BROKER_QUOTE_UNAVAILABLE",
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
    bridgeConnectionId,
    ...("error" in spec ? { error: "BROKER_SPEC_READ_FAILED" } : {}),
  };
}

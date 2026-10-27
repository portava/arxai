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
// The store's priceless "not available" placeholder is never passed on.
// Point: the broker's own SYMBOL_POINT from arx_symbol_specs, to measure spread
// and deviation in broker points like the EA pre-trade guard does.
// Symbol: the EA quotes and reports specs under the broker's exact Market Watch
// name ("EURUSD.r", "Volatility 75 Index"), while the command row carries the
// ARX-internal name. Both reads use the same resolver the transport applies when
// the command leaves for the EA (liveCommandPipeline → resolveBrokerSymbolName),
// then match exactly: no case-folding, suffix guessing or alias invention here.
// Bridge: the quote store is partitioned by the bridge connection that pushed
// the tick (mt5Provider Mt5BridgeIdentity). The observer reads ONLY the dispatch
// bridge's partition, so another bridge quoting the same symbol can never supply
// this command's quote fact; a dispatch without a bridge identity refuses. There
// is no unscoped read on this path.
// EA supply: when the quote is missing, the observation also states whether the
// bridge's EA build streams quotes at all (eaQuoteSupply.ts), so the refusal
// explains "EA v1.31 does not stream broker quotes" rather than a bare
// UNAVAILABLE. The outcome is unchanged: no quote, no entry.
// Provenance: the store stamps a tick at the EA time it was FIRST seen in the
// bridge's partition (the EA re-posts its last tick every sweep), and records
// the feed's previous post. The observer copies that verbatim; the claim
// refuses a tick whose occurrence no earlier post bounds (freshFacts.ts).
import { readMt5Quote, type Mt5TickProvenance } from "../data/providers/mt5Provider.js";
import { resolveBrokerSymbolName } from "../instruments/index.js";
import { getBrokerSymbolSpec } from "../mt5/brokerSymbolSpec.js";
import { describeEaQuoteSupply } from "./eaQuoteSupply.js";
import type { EntryMarketObservation } from "./freshFacts.js";

export const ENTRY_QUOTE_SOURCE = "mt5_broker";

export interface EntryObservationContext {
  /** The bridge the command is being dispatched to (dispatchLiveCommand's `bridge.id`). */
  bridgeConnectionId: number | null | undefined;
  /** That bridge's heartbeat-reported EA version (`bridge.eaVersion`), for the supply note. */
  eaVersion?: string | null;
}

export async function observeAgentEntryMarket(
  userId: number,
  symbol: string,
  context: EntryObservationContext,
): Promise<EntryMarketObservation> {
  const bridgeConnectionId =
    typeof context.bridgeConnectionId === "number" && Number.isFinite(context.bridgeConnectionId)
      ? context.bridgeConnectionId
      : null;
  const eaVersion =
    typeof context.eaVersion === "string" && context.eaVersion.trim() !== ""
      ? context.eaVersion.trim()
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
    eaVersion,
    eaQuoteSupply: describeEaQuoteSupply(eaVersion),
  });
  if (bridgeConnectionId == null) return unavailable("BROKER_QUOTE_BRIDGE_UNKNOWN", null);
  let brokerSymbol: string;
  try {
    brokerSymbol = await resolveBrokerSymbolName(symbol);
  } catch {
    return unavailable("BROKER_SYMBOL_RESOLVE_FAILED", null);
  }
  const [read, spec] = await Promise.all([
    Promise.resolve()
      .then(() => readMt5Quote(brokerSymbol, { bridgeConnectionId }))
      .catch((err: unknown) => ({ error: err })),
    getBrokerSymbolSpec(userId, brokerSymbol).catch((err: unknown) => ({ error: err })),
  ]);
  const point =
    "error" in spec ? null : spec.hasBrokerTruth ? spec.spec.point : null;
  const quote = "error" in read ? null : read.quote;
  if ("error" in read || quote == null || (quote.bid == null && quote.ask == null))
    return unavailable(
      "error" in read ? "BROKER_QUOTE_READ_FAILED" : "BROKER_QUOTE_UNAVAILABLE",
      brokerSymbol,
      point,
    );
  return {
    bid: quote.bid ?? null,
    ask: quote.ask ?? null,
    observedAt: quote.timestamp ?? null,
    tickProvenance: copyProvenance(read.tick),
    source: ENTRY_QUOTE_SOURCE,
    point,
    brokerClockOffsetMs:
      typeof quote.brokerClockOffsetMs === "number" && Number.isFinite(quote.brokerClockOffsetMs)
        ? quote.brokerClockOffsetMs
        : null,
    requestedSymbol: symbol,
    brokerSymbol,
    bridgeConnectionId,
    eaVersion,
    ...("error" in spec ? { error: "BROKER_SPEC_READ_FAILED" } : {}),
  };
}

/** The store's first-sight provenance as ISO instants; null when the quote has none. */
function copyProvenance(tick: Mt5TickProvenance | null | undefined): EntryMarketObservation["tickProvenance"] {
  if (tick == null) return null;
  const iso = (ms: unknown) =>
    typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : ms ?? null;
  return {
    firstSeenAt: iso(tick.firstSeenEaMs),
    lastPostedAt: iso(tick.lastPostedEaMs),
    reposts: tick.reposts,
    priorPostAt: tick.priorPostEaMs == null ? null : iso(tick.priorPostEaMs),
  };
}

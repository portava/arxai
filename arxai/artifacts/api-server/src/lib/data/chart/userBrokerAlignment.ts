// Per-user broker alignment enrichment for a shared chart intelligence state.
//
// The base state is shared across users and carries the noBrokerAlignment
// placeholder (symbol mirror unmeasured). Candidates, in order: (1) the live
// MT5 quote pushed by the SAME bridge that produced the served series
// (bridge-pinned in-memory read); (2) the user's EA-reported arx_symbol_specs
// row. Each candidate is bound to the series' observed identity and its
// observed tick time (brokerQuoteBinding.ts). Only a BOUND quote can earn
// chart-Truth points or claim alignment; an unbound quote's numbers stay a
// visible, unmeasured comparison with named reasons. Missing quotes leave the
// placeholder in place: absence is never treated as a successful match.
//
// SAFETY: READ-ONLY. Fail-open to the unenriched state on any lookup error.

import { eq, and } from "drizzle-orm";
import { db, arxSymbolSpecsTable } from "@workspace/db";
import {
  getCachedIntelligenceContext,
  enrichStateWithBrokerAlignment,
  type ChartIntelligenceState,
} from "./chartIntelligence.js";
import type { ChartTimeframe } from "./timeframes.js";
import {
  observationFromMt5Quote,
  observationFromSymbolSpec,
  selectBrokerQuote,
} from "./brokerQuoteBinding.js";
import { readMt5Quote } from "../providers/mt5Provider.js";

export async function enrichStateWithUserBrokerQuote(
  state: ChartIntelligenceState,
  args: { userId: number; symbol: string; timeframe: ChartTimeframe; limit: number },
): Promise<ChartIntelligenceState> {
  const ctx = getCachedIntelligenceContext(args.symbol, args.timeframe, args.limit);
  if (!ctx) return state;
  const series = ctx.seriesAttribution;
  // Never read another user's bridge quote: pin only to a series this user's
  // own bridge produced.
  const live = series?.bridgeConnectionId != null && series.userId === args.userId
    ? observationFromMt5Quote(readMt5Quote(args.symbol, { bridgeConnectionId: series.bridgeConnectionId }))
    : null;
  const specRow = await db
    .select({
      userId: arxSymbolSpecsTable.userId,
      bridgeConnectionId: arxSymbolSpecsTable.bridgeConnectionId,
      accountType: arxSymbolSpecsTable.accountType,
      brokerSymbol: arxSymbolSpecsTable.brokerSymbol,
      bid: arxSymbolSpecsTable.bid,
      ask: arxSymbolSpecsTable.ask,
      spreadPoints: arxSymbolSpecsTable.spreadPoints,
      lastTickTime: arxSymbolSpecsTable.lastTickTime,
    })
    .from(arxSymbolSpecsTable)
    .where(and(
      eq(arxSymbolSpecsTable.userId, args.userId),
      eq(arxSymbolSpecsTable.symbol, args.symbol.toUpperCase()),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  const snapshot = specRow?.bid != null && specRow.ask != null ? observationFromSymbolSpec(specRow) : null;
  const { quote, binding } = selectBrokerQuote([live, snapshot], {
    series, requestingUserId: args.userId, now: Date.now(),
  });
  if (!quote) return state;
  return enrichStateWithBrokerAlignment(ctx.state, ctx.truthResult, ctx.feedStatus, {
    chartPrice: ctx.state.latestClosedCandle?.close ?? null,
    // Preserve the served series' observed basis. Asset class cannot establish
    // whether an original candle is BID, MID or LAST.
    chartPriceBasis: ctx.truthResult?.priceBasis ?? "UNKNOWN",
    assetClass: ctx.state.assetClass,
    brokerBid: quote.bid,
    brokerAsk: quote.ask,
    spreadPoints: quote.spreadPoints,
    quoteBinding: binding,
  });
}

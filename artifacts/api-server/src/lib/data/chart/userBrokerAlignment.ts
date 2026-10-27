// Per-user broker alignment enrichment for a shared chart intelligence state.
//
// The base state is shared across users and carries the noBrokerAlignment
// placeholder (symbol mirror unmeasured). This looks up the user's EA-reported
// bid/ask from arx_symbol_specs and, when present, recomputes broker alignment,
// truth score and gate output from that real comparison. Missing quotes leave
// the placeholder in place: absence is never treated as a successful match.
//
// Known gap: the spec row's quote age and account provenance are not checked
// here (see docs/CHART_TRUTH_EVIDENCE_COVERAGE.md).
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

/**
 * Derive an appropriate chart-price basis from the asset class.
 * For provider-sourced candles (TwelveData, Polygon) forex/metals/indices/crypto
 * use mid-market rates. Synthetics are derived prices. Others default to LAST.
 * Phase 4 can refine this per-provider when richer source metadata is available.
 */
export function deriveChartPriceBasis(assetClass: string): string {
  if (assetClass === "synthetic") return "SYNTHETIC";
  if (assetClass === "forex" || assetClass === "metals") return "MID";
  return "LAST";
}

export async function enrichStateWithUserBrokerQuote(
  state: ChartIntelligenceState,
  args: { userId: number; symbol: string; timeframe: ChartTimeframe; limit: number },
): Promise<ChartIntelligenceState> {
  const specRow = await db
    .select({
      bid: arxSymbolSpecsTable.bid,
      ask: arxSymbolSpecsTable.ask,
      spreadPoints: arxSymbolSpecsTable.spreadPoints,
    })
    .from(arxSymbolSpecsTable)
    .where(and(
      eq(arxSymbolSpecsTable.userId, args.userId),
      eq(arxSymbolSpecsTable.symbol, args.symbol.toUpperCase()),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (specRow?.bid == null || specRow.ask == null) return state;
  const ctx = getCachedIntelligenceContext(args.symbol, args.timeframe, args.limit);
  if (!ctx) return state;
  return enrichStateWithBrokerAlignment(ctx.state, ctx.truthResult, ctx.feedStatus, {
    chartPrice: state.latestClosedCandle?.close ?? null,
    chartPriceBasis: deriveChartPriceBasis(state.assetClass),
    assetClass: state.assetClass,
    brokerBid: specRow.bid,
    brokerAsk: specRow.ask,
    spreadPoints: specRow.spreadPoints ?? null,
  });
}

// Chart Brain v2 — Task 1: Chart Intelligence State endpoint (Fast Brain).
// SAFETY: requireUser (per-user gated → 401 when unauthenticated). Read-only;
// never places, modifies, or closes a trade. Base state is built from public
// candle-truth only; broker alignment enrichment is per-user but read-only.
// Never blocks candle rendering or live execution.
import { Router } from "express";
import { eq, and } from "drizzle-orm";
import { db, arxSymbolSpecsTable } from "@workspace/db";
import { GetMeChartIntelligenceQueryParams } from "@workspace/api-zod";
import { requireUser } from "../lib/auth/middleware.js";
import {
  buildChartIntelligenceState,
  getCachedIntelligenceContext,
  enrichStateWithBrokerAlignment,
} from "../lib/data/chart/chartIntelligence.js";
import {
  observationFromMt5Quote,
  observationFromSymbolSpec,
  selectBrokerQuote,
} from "../lib/data/chart/brokerQuoteBinding.js";
import { readMt5Quote } from "../lib/data/providers/mt5Provider.js";

const router = Router();
const SAFETY_ENVELOPE = {
  safetyMode: "paper_only" as const,
  liveLocked: true as const,
  readOnlyMode: true as const,
  allowOrderExecution: false as const,
};

/**
 * Derive an appropriate chart-price basis from the asset class.
 * For provider-sourced candles (TwelveData, Polygon) forex/metals/indices/crypto
 * use mid-market rates. Synthetics are derived prices. Others default to LAST.
 * Phase 4 can refine this per-provider when richer source metadata is available.
 */
function deriveChartPriceBasis(assetClass: string): string {
  if (assetClass === "synthetic") return "SYNTHETIC";
  if (assetClass === "forex" || assetClass === "metals") return "MID";
  return "LAST";
}

router.get("/me/chart/intelligence", requireUser, async (req, res): Promise<void> => {
  let q;
  try {
    q = GetMeChartIntelligenceQueryParams.parse({
      symbol: req.query["symbol"],
      timeframe: req.query["timeframe"] ?? "M5",
      limit: req.query["limit"] != null ? Number(req.query["limit"]) : 300,
    });
  } catch (err) {
    req.log.warn({ err }, "invalid chart intelligence request");
    res.status(400).json({ error: "Invalid chart intelligence request" });
    return;
  }

  // Build (or return cached) base state — shared across users.
  let state = await buildChartIntelligenceState(q.symbol, q.timeframe, q.limit);

  // Route-level enrichment: compare the chart close with a broker quote for
  // this user. Candidates, in order: (1) the live MT5 quote pushed by the SAME
  // bridge that produced the served series (in-memory, bridge-pinned read);
  // (2) the EA-reported symbol snapshot in arx_symbol_specs. Each candidate is
  // bound to the series' observed identity and its observed tick time; only a
  // BOUND quote can earn chart-Truth points or claim alignment. An unbound
  // quote's numbers stay a visible, unmeasured comparison with named reasons.
  // Fail-open: any error falls through to the base state with the
  // noBrokerAlignment placeholder.
  const userId = req.authUser?.id;
  if (userId != null) {
    try {
      const ctx = getCachedIntelligenceContext(q.symbol, q.timeframe, q.limit);
      if (ctx) {
        const symUpper = q.symbol.toUpperCase();
        const series = ctx.seriesAttribution;
        // Never read another user's bridge quote: pin only to a series this
        // user's own bridge produced.
        const live = series?.bridgeConnectionId != null && series.userId === userId
          ? observationFromMt5Quote(readMt5Quote(q.symbol, { bridgeConnectionId: series.bridgeConnectionId }))
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
            eq(arxSymbolSpecsTable.userId, userId),
            eq(arxSymbolSpecsTable.symbol, symUpper),
          ))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        const snapshot = specRow?.bid != null && specRow.ask != null ? observationFromSymbolSpec(specRow) : null;
        const { quote, binding } = selectBrokerQuote([live, snapshot], {
          series, requestingUserId: userId, now: Date.now(),
        });
        if (quote) {
          const chartPriceBasis = deriveChartPriceBasis(state.assetClass);
          // computeBrokerPriceAlignment exposed via enrichStateWithBrokerAlignment;
          // adminDetail is stripped below before returning to the end user.
          state = enrichStateWithBrokerAlignment(ctx.state, ctx.truthResult, ctx.feedStatus, {
            chartPrice: state.latestClosedCandle?.close ?? null,
            chartPriceBasis,
            assetClass: state.assetClass,
            brokerBid: quote.bid,
            brokerAsk: quote.ask,
            spreadPoints: quote.spreadPoints,
            quoteBinding: binding,
          });
        }
      }
    } catch (enrichErr) {
      req.log.warn({ enrichErr }, "broker alignment enrichment failed — using placeholder");
    }
  }

  // Strip adminDetail from the brokerAlignment before serializing — this field
  // contains raw bid/ask/deviation numbers that must not reach end users.
  const { adminDetail: _adminDetail, ...safeAlignment } = state.brokerAlignment;
  const safeState = { ...state, brokerAlignment: { ...safeAlignment, adminDetail: null } };

  res.json({ state: safeState, ...SAFETY_ENVELOPE });
});

export default router;

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
import { computeBrokerPriceAlignment } from "../lib/data/chart/brokerPriceAlignment.js";

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

  // Route-level enrichment: look up per-user broker bid/ask from arx_symbol_specs
  // (EA-reported truth). If found, recompute broker alignment, truth score and
  // gate output with real data so the response reflects the actual chart vs
  // broker divergence for this user. Fail-open: any error falls through to the
  // base state with the noBrokerAlignment placeholder.
  const userId = req.authUser?.id;
  if (userId != null) {
    try {
      const symUpper = q.symbol.toUpperCase();
      const specRow = await db
        .select({
          bid: arxSymbolSpecsTable.bid,
          ask: arxSymbolSpecsTable.ask,
          spreadPoints: arxSymbolSpecsTable.spreadPoints,
        })
        .from(arxSymbolSpecsTable)
        .where(and(
          eq(arxSymbolSpecsTable.userId, userId),
          eq(arxSymbolSpecsTable.symbol, symUpper),
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null);

      if (specRow?.bid != null && specRow.ask != null) {
        const ctx = getCachedIntelligenceContext(q.symbol, q.timeframe, q.limit);
        if (ctx) {
          const chartPriceBasis = deriveChartPriceBasis(state.assetClass);
          // computeBrokerPriceAlignment exposed via enrichStateWithBrokerAlignment;
          // adminDetail is stripped below before returning to the end user.
          state = enrichStateWithBrokerAlignment(ctx.state, ctx.truthResult, ctx.feedStatus, {
            chartPrice: state.latestClosedCandle?.close ?? null,
            chartPriceBasis,
            assetClass: state.assetClass,
            brokerBid: specRow.bid,
            brokerAsk: specRow.ask,
            spreadPoints: specRow.spreadPoints ?? null,
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

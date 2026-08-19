// Build DD — Market Data Read Layer routes.
//
// SAFETY: 100% read-only. None of these endpoints place trades, mutate
// safetyCore, touch MT5 surfaces, or expose API secrets. Demo endpoint
// is illustrative only.

import { Router, type Response } from "express";
import { z } from "zod/v4";
import {
  getMarketData,
  marketDataHealthCheck,
  computeBlockers,
  summarizeForAA,
} from "../lib/marketData/marketDataService.js";

const router: Router = Router();

const DISCLAIMER =
  "Market data is READ-ONLY decision support. This service never places trades, " +
  "never mutates safetyCore, and never bypasses kill-switch, risk locks, or the canPlaceTrades gate. " +
  "FALLBACK data is synthetic and clearly labeled.";

function ok(res: Response, body: Record<string, unknown>) {
  return res.json({ ...body, system: "marketData", disclaimer: DISCLAIMER });
}
function fail(res: Response, status: number, error: string) {
  return res.status(status).json({ error, system: "marketData", disclaimer: DISCLAIMER });
}

const TimeframeEnum = z.enum(["M1", "M5", "M15", "M30", "H1", "H4", "D1"]);

// GET /api/market-data/quote?symbol=...
router.get("/market-data/quote", async (req, res) => {
  const symbol = String(req.query.symbol ?? "Volatility 75 Index");
  try {
    const { snapshot, blockers, usedFallback, providerError } = await getMarketData({
      symbol, timeframe: "M5", limit: 100,
    });
    return ok(res, {
      symbol: snapshot.symbol,
      source: snapshot.source,
      provider: snapshot.provider,
      bid: snapshot.bid,
      ask: snapshot.ask,
      mid: snapshot.mid,
      spread: snapshot.spread,
      timestamp: snapshot.timestamp,
      sessionContext: snapshot.sessionContext,
      dataQuality: snapshot.dataQuality,
      blockers,
      usedFallback,
      providerError: providerError ?? null,
    });
  } catch (err) {
    return fail(res, 500, `quote error: ${String(err)}`);
  }
});

// GET /api/market-data/candles?symbol=...&timeframe=M5&limit=100
router.get("/market-data/candles", async (req, res) => {
  const symbol = String(req.query.symbol ?? "Volatility 75 Index");
  const tfParse = TimeframeEnum.safeParse(req.query.timeframe ?? "M5");
  const timeframe = tfParse.success ? tfParse.data : "M5";
  const limit = Math.min(500, Math.max(10, Number(req.query.limit ?? 100) || 100));
  try {
    const { snapshot, blockers, usedFallback } = await getMarketData({ symbol, timeframe, limit });
    return ok(res, {
      symbol: snapshot.symbol,
      timeframe: snapshot.timeframe,
      source: snapshot.source,
      provider: snapshot.provider,
      candlesAvailable: snapshot.candles.length,
      candles: snapshot.candles.slice(-limit),
      dataQuality: snapshot.dataQuality,
      blockers,
      usedFallback,
    });
  } catch (err) {
    return fail(res, 500, `candles error: ${String(err)}`);
  }
});

// GET /api/market-data/health
router.get("/market-data/health", async (_req, res) => {
  try {
    const h = await marketDataHealthCheck();
    return ok(res, { health: h });
  } catch (err) {
    return fail(res, 500, `health error: ${String(err)}`);
  }
});

// POST /api/market-data/demo — fetches once + shows the AA summary shape
const DemoBody = z.object({
  symbol: z.string().default("Volatility 75 Index"),
  timeframe: TimeframeEnum.default("M5"),
  limit: z.number().int().min(10).max(500).default(100),
});

router.post("/market-data/demo", async (req, res) => {
  const parse = DemoBody.safeParse(req.body ?? {});
  if (!parse.success) return fail(res, 400, parse.error.message);
  const { symbol, timeframe, limit } = parse.data;
  try {
    const result = await getMarketData({ symbol, timeframe, limit });
    return ok(res, {
      input: { symbol, timeframe, limit },
      snapshot: {
        symbol: result.snapshot.symbol,
        source: result.snapshot.source,
        provider: result.snapshot.provider,
        bid: result.snapshot.bid,
        ask: result.snapshot.ask,
        mid: result.snapshot.mid,
        spread: result.snapshot.spread,
        timestamp: result.snapshot.timestamp,
        timeframe: result.snapshot.timeframe,
        candlesAvailable: result.snapshot.candles.length,
        sessionContext: result.snapshot.sessionContext,
        dataQuality: result.snapshot.dataQuality,
      },
      blockers: result.blockers,
      usedFallback: result.usedFallback,
      providerError: result.providerError ?? null,
      aaSummary: summarizeForAA(result.snapshot, result.blockers),
      computedBlockersFresh: computeBlockers(result.snapshot),
    });
  } catch (err) {
    return fail(res, 500, `demo error: ${String(err)}`);
  }
});

export default router;

import { Router } from "express";
import { GetMarketCandlesQueryParams, GetMarketQuoteQueryParams } from "@workspace/api-zod";
import { getMarketData, getLatestQuote, getProviderStatus } from "../lib/data/dataManager.js";
import { resolveArxMarket, ARX_FOCUS_BLOCKED_REASON } from "@workspace/domain/market";

const router = Router();

// Task #558 — ARX Focus market backstop (additive, defense-in-depth). Every
// market-facing endpoint validates the requested symbol through the registry
// BEFORE any candle/quote fetch. An unapproved symbol returns a clean blocked
// envelope with NO market data and NO provider info — it never replaces or
// relaxes any other check; it only adds one honest refusal.
function arxFocusBlockedEnvelope(requestedSymbol: string) {
  return { requestedSymbol, isApprovedMarket: false as const, blocked: true as const, reason: ARX_FOCUS_BLOCKED_REASON };
}

router.get("/data/providers/status", async (_req, res) => {
  res.json(await getProviderStatus());
});

// DEPRECATED (Task #407): bare candle-array endpoint. The single chart/analysis
// truth contract is now GET /api/chart/candles (carries the shared feedStatus +
// quality verdict). The active UI no longer consumes this route — only legacy QA
// scripts (health/regression probes) still hit it for a plain OHLC array. Do NOT
// wire new UI or analysis surfaces to it; use /api/chart/candles instead. It
// still returns real candles or an honest empty array — never fabricated data.
router.get("/data/candles", async (req, res) => {
  try {
    const q = GetMarketCandlesQueryParams.parse({
      symbol: req.query["symbol"],
      timeframe: req.query["timeframe"] ?? "1m",
      limit: req.query["limit"] ? Number(req.query["limit"]) : 100,
    });
    if (!resolveArxMarket(q.symbol)) {
      res.status(200).json(arxFocusBlockedEnvelope(q.symbol));
      return;
    }
    const candles = await getMarketData(q.symbol, q.timeframe ?? "1m", q.limit ?? 100);
    res.json(candles);
  } catch (err) {
    req.log.error(err);
    res.status(400).json({ error: "Invalid candles request" });
  }
});

router.get("/data/quote", async (req, res) => {
  try {
    const q = GetMarketQuoteQueryParams.parse({ symbol: req.query["symbol"] });
    if (!resolveArxMarket(q.symbol)) {
      res.status(200).json(arxFocusBlockedEnvelope(q.symbol));
      return;
    }
    res.json(await getLatestQuote(q.symbol));
  } catch (err) {
    req.log.error(err);
    res.status(400).json({ error: "Invalid quote request" });
  }
});

export default router;

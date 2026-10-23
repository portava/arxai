import { Router } from "express";
import {
  GetChartCandlesQueryParams,
  GetChartFeedStatusQueryParams,
  GetChartHistoryQueryParams,
} from "@workspace/api-zod";
import { getChartCandles, getChartFeedStatus } from "../lib/data/chart/chartDataService.js";
import { getCandleHistory } from "../lib/data/candleHistoryService.js";
import { handleChartTickStream } from "./chartTickStream.js";
import { resolveArxMarket, ARX_FOCUS_BLOCKED_REASON } from "@workspace/domain/market";

const router = Router();

// Task #558 — ARX Focus market backstop (additive). Validate the requested
// symbol through the registry BEFORE any chart fetch; an unapproved symbol gets
// a clean blocked envelope with no candles/feed data and no provider info.
function arxFocusBlockedEnvelope(requestedSymbol: string) {
  return { requestedSymbol, isApprovedMarket: false as const, blocked: true as const, reason: ARX_FOCUS_BLOCKED_REASON };
}

// ARX Native Chart — Level 1: normalized candle + feed-status truth contract.
// Built over the EXISTING market-data router. Never fabricates candles; an
// unavailable feed returns an honest empty list with quality/warning. The
// legacy /api/data/candles endpoint is intentionally left unchanged.

router.get("/chart/candles", async (req, res) => {
  let q;
  try {
    q = GetChartCandlesQueryParams.parse({
      symbol: req.query["symbol"],
      timeframe: req.query["timeframe"] ?? "M5",
      limit: req.query["limit"] != null ? Number(req.query["limit"]) : 300,
    });
  } catch (err) {
    req.log.warn({ err }, "invalid chart candles request");
    res.status(400).json({ error: "Invalid chart candles request" });
    return;
  }
  if (!resolveArxMarket(q.symbol)) {
    res.status(200).json(arxFocusBlockedEnvelope(q.symbol));
    return;
  }
  // Task #496 — display route opts INTO the synthesized real-time forming tip.
  // Analysis / Ruby / chart-intelligence callers keep the default (false) and
  // stay strictly closed-bars-only.
  const out = await getChartCandles(q.symbol, q.timeframe, q.limit, true);
  res.json(out);
});

router.get("/chart/feed-status", async (req, res) => {
  let q;
  try {
    q = GetChartFeedStatusQueryParams.parse({
      symbol: req.query["symbol"],
      timeframe: req.query["timeframe"] ?? "M5",
    });
  } catch (err) {
    req.log.warn({ err }, "invalid chart feed-status request");
    res.status(400).json({ error: "Invalid chart feed-status request" });
    return;
  }
  if (!resolveArxMarket(q.symbol)) {
    res.status(200).json(arxFocusBlockedEnvelope(q.symbol));
    return;
  }
  // Task #496 — display feed-status reflects the live forming tip so the badge
  // reads LIVE while ticks flow (and frozen-stale when silent). Analysis / health
  // callers keep the default (false).
  const out = await getChartFeedStatus(q.symbol, q.timeframe, true);
  res.json(out);
});

// Task #496 — real-time forming-bar tick stream (SSE).
//
// Pushes the still-forming (current-interval) bar synthesized from live EA ticks
// so the chart tip ticks in real time without the client re-fetching the whole
// candle window. The frontend applies each event with series.update() (no
// repaint) and demotes its 15s candle poll to a reconciliation safety net.
//
// HONESTY / SAFETY:
//   - The payload carries ONLY OHLC + bar time + an `isForming`/`frozen` marker.
//     No tokens, account, balance, gate, or bridge data — pure display telemetry.
//   - The bar is server-synthesized and NEVER persisted. When ticks go silent
//     (>15s) we emit a `frozen` marker so the client stops reading it as live.
//   - No execution surface: no arx_live_* table, no 16-gate, no fill/balance.
//   - Authed by the global gate (chart router is mounted behind it), same as the
//     other chart endpoints.
//   - LATENCY (Task #496 addendum): each accepted tick is pushed the INSTANT
//     ingest folds it — no coalescing/aggregation timer between ingest and the
//     SSE write. Every event carries `tickWallMs` so the client can measure the
//     ingest→browser latency. Implementation in ./chartTickStream.ts (DB-free so
//     the immediate-push path is covered by an HTTP-level acceptance test).
router.get("/chart/tick-stream", handleChartTickStream);

// Task #432 — deep, scrollable candle history with a `before` cursor and honest
// metadata. Market-data telemetry only; serves one coherent source per page and
// never labels historical/stale data as live. /api/chart/candles is unchanged.
router.get("/chart/history", async (req, res) => {
  let q;
  try {
    q = GetChartHistoryQueryParams.parse({
      symbol: req.query["symbol"],
      timeframe: req.query["timeframe"] ?? "M5",
      limit: req.query["limit"] != null ? Number(req.query["limit"]) : 500,
      before: req.query["before"],
      source: req.query["source"],
    });
  } catch (err) {
    req.log.warn({ err }, "invalid chart history request");
    res.status(400).json({ error: "Invalid chart history request" });
    return;
  }
  if (!resolveArxMarket(q.symbol)) {
    res.status(200).json(arxFocusBlockedEnvelope(q.symbol));
    return;
  }
  const out = await getCandleHistory({
    symbol: q.symbol,
    timeframe: q.timeframe,
    limit: q.limit,
    before: q.before ?? null,
    source: q.source ?? null,
  });
  res.json(out);
});

export default router;

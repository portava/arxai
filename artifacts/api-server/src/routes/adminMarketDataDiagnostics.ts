// Admin-only market data diagnostics.
//
// GET /api/admin/market-data/diagnostics
//   Returns the per-provider health snapshot + per-asset-class chain.
//
// GET /api/admin/market-data/diagnostics?symbol=EURUSD
//   Additionally probes the router for that symbol and returns the
//   provider-attempt chain (which provider was tried, ok/failed, reason).
//
// Never exposes raw API keys or env values. Reasons are pre-redacted
// inside the router. Mirrors the auth shape of adminDerivStatus.ts.

import { type Request, type Response, Router } from "express";
import { getRouterDiagnostics, routeCandles, classifySymbol } from "../lib/data/marketDataRouter.js";
import {
  getMt5AllSeriesStatus,
  getMt5SeriesFreshness,
  mt5Provider,
  type Mt5SeriesStatusEntry,
} from "../lib/data/providers/mt5Provider.js";
import { buildCandleDepthReport } from "../lib/data/candleDepthDiagnostics.js";
import { getBrokerCandleCoverage } from "../lib/data/brokerCandleStore.js";
import { getIngestRejections } from "../lib/data/ingestRejectionCounter.js";
import { getEconomicCalendarDiagnostics } from "../lib/news/calendar/economicCalendarService.js";
import { evaluateLiveDistributionOod } from "../lib/ood/distributionOodService.js";
import { getAllApprovedArxMarkets } from "@workspace/domain/market";

const router: Router = Router();

function requireAdmin(req: Request, res: Response): { id: number; role: "ADMIN" | "OWNER" } | null {
  // The app's per-user auth middleware attaches the authenticated user at
  // `req.authUser` (see lib/auth/middleware.ts). Role is normalized
  // case-insensitively, matching the canonical admin gate.
  const u = (req as unknown as { authUser?: { id: number; role?: string } }).authUser;
  if (!u) { res.status(401).json({ error: "AUTH_REQUIRED" }); return null; }
  const role = String(u.role ?? "").toUpperCase();
  if (role !== "ADMIN" && role !== "OWNER") {
    res.status(403).json({ error: "FORBIDDEN", message: "Admin or Owner role required." });
    return null;
  }
  return { id: u.id, role: role as "ADMIN" | "OWNER" };
}

router.get("/admin/market-data/diagnostics", async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const snapshot = getRouterDiagnostics();

  // Focus-Lock visibility (Task #570): surface the approved ARX Focus universe
  // so an admin can confirm exactly which markets are in-scope. Read-only —
  // derived from the single source of truth (ARX_FOCUS_MARKETS).
  const approvedMarkets = getAllApprovedArxMarkets();
  const byCategory = approvedMarkets.reduce<Record<string, number>>((acc, mk) => {
    acc[mk.category] = (acc[mk.category] ?? 0) + 1;
    return acc;
  }, {});
  const approvedUniverse = {
    count: approvedMarkets.length,
    byCategory,
    markets: approvedMarkets.map((mk) => ({
      canonicalSymbol: mk.canonicalSymbol,
      displayName: mk.displayName,
      category: mk.category,
      priorityTier: mk.priorityTier,
    })),
  };

  const symbol = typeof req.query.symbol === "string" ? req.query.symbol.trim() : "";
  if (!symbol) {
    res.json({ ok: true, snapshot, approvedUniverse });
    return;
  }

  // Optional symbol probe — fetch a small candle window so admin can see
  // which provider in the chain actually answered.
  try {
    const probe = await routeCandles(symbol, "M5", 5);
    res.json({
      ok: true,
      snapshot,
      approvedUniverse,
      probe: {
        symbol,
        assetClass: probe.assetClass,
        feedOk: probe.ok,
        primaryProvider: probe.primaryProvider,
        candleCount: probe.candles.length,
        attempts: probe.attempts,
        userMessage: probe.userMessage,
        adminDetail: probe.adminDetail,
      },
    });
  } catch (err) {
    res.json({
      ok: true,
      snapshot,
      approvedUniverse,
      probe: {
        symbol,
        assetClass: classifySymbol(symbol),
        feedOk: false,
        primaryProvider: null,
        candleCount: 0,
        attempts: [],
        userMessage: "Probe failed.",
        adminDetail: String((err as Error).message ?? err).slice(0, 280),
      },
    });
  }
});

// GET /api/admin/market-data/mt5-feed
//
// Returns the contribution status of every symbol+timeframe series pushed by
// the EA since the server last started. Shows whether MT5 is actively
// contributing candles to the chart layer, or has stale / no data.
//
// Status meanings (per series):
//   contributing     — fresh data (< 5 min old), non-empty — this series IS
//                      answering chart requests from the mt5_broker router slot
//   stale            — pushed data exists but is older than CANDLE_TTL (5 min)
//                      — the router falls through to the next provider
//   non-contributing — no data for this series, but the MT5 feed IS connected
//                      (the EA is pushing other series) — just not this one
//   unavailable      — no data for this series AND the MT5 feed is not connected
//                      at all (the bridge candle feed mechanism is offline)
//
// The overall feedActive flag is the AUTHORITATIVE provider freshness signal:
// it reflects mt5Provider.isConnected() (any series OR quote fresh within 60s),
// NOT a derivation from the per-series list. A series can be "stale" while the
// provider is still connected via a different fresh series/quote, and vice
// versa, so feedActive must come from the provider itself.
//
// Optional query param ?symbol=EURUSD&timeframe=M5 narrows to a single series.
router.get("/admin/market-data/mt5-feed", async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  // AUTHORITATIVE provider connectivity — drives feedActive and disambiguates
  // "non-contributing" (feed up, this symbol absent) from "unavailable"
  // (feed entirely offline).
  const providerConnected = await mt5Provider.isConnected();

  const filterSymbol = typeof req.query.symbol === "string" ? req.query.symbol.trim() : "";
  const filterTimeframe = typeof req.query.timeframe === "string" ? req.query.timeframe.trim() : "";

  let series: Mt5SeriesStatusEntry[];

  if (filterSymbol && filterTimeframe) {
    // Single-series probe.
    const freshness = getMt5SeriesFreshness(filterSymbol, filterTimeframe);
    if (!freshness.hasSeries) {
      series = [{
        symbol: filterSymbol,
        timeframe: filterTimeframe,
        // No data for this exact series. If the feed is connected elsewhere the
        // EA simply isn't pushing this symbol/timeframe (non-contributing);
        // if the whole feed is down it is unavailable.
        status: providerConnected ? "non-contributing" : "unavailable",
        barCount: 0,
        ageMs: null,
        updatedAt: null,
      }];
    } else {
      series = [{
        symbol: filterSymbol,
        timeframe: filterTimeframe,
        // Mirror getMt5AllSeriesStatus EXACTLY so the single-series probe and the
        // full-list path never disagree for the same series: aged-out → "stale"
        // (router falls through); fresh + bars → "contributing"; fresh but empty
        // → "non-contributing" (live feed, no usable bars yet — NOT stale).
        status: !freshness.fresh ? "stale" : freshness.barCount > 0 ? "contributing" : "non-contributing",
        barCount: freshness.barCount,
        ageMs: freshness.ageMs,
        updatedAt: freshness.ageMs != null ? new Date(Date.now() - freshness.ageMs).toISOString() : null,
      }];
    }
  } else {
    series = getMt5AllSeriesStatus();
  }

  const contributingCount = series.filter((s) => s.status === "contributing").length;
  const staleCount = series.filter((s) => s.status === "stale").length;
  const nonContributingCount = series.filter((s) => s.status === "non-contributing").length;
  const unavailableCount = series.filter((s) => s.status === "unavailable").length;

  res.json({
    ok: true,
    feedActive: providerConnected,
    providerConnected,
    summary: {
      totalSeries: series.length,
      contributing: contributingCount,
      stale: staleCount,
      nonContributing: nonContributingCount,
      unavailable: unavailableCount,
    },
    series,
    note: !providerConnected
      ? (series.length === 0
        ? "MT5 candle feed is not connected — no series pushed since server start. MT5 is unavailable; the router falls through to Deriv / the assistant composite. This is normal until the EA sends its first sync-candles payload."
        : "MT5 candle feed is not connected (no fresh push within 60s). Previously-pushed series are stale; the router falls through to Deriv / the assistant composite for all symbols.")
      : contributingCount === 0
        ? "MT5 feed is connected but no series is currently contributing fresh candles to the chart layer."
        : `MT5 is actively contributing ${contributingCount} series.`,
  });
});

// GET /api/admin/market-data/candle-depth?symbol=EURUSD
//
// On-demand "Test Candle Depth" runner. For the given symbol it probes the six
// canonical chart timeframes (1m/5m/15m/1h/4h/1D) through the SAME
// getCandleHistory path a real chart-history scroll uses, and returns the
// per-timeframe depth report: source, requested vs returned, oldest/newest,
// history depth (coverage vs target), candle age, live-quote availability,
// provider errors, cache count, can-load-more, execution mapping, and broker-
// symbol resolution — plus a pass/fail verdict and the exact oldest candle each.
//
// Read-only market-data telemetry. Touches no execution path, no arx_live_*
// table, no balance/fill, and no safety gate. `symbol` is REQUIRED so a single
// click cannot fan out provider load across the whole universe. Status comes
// verbatim from getCandleHistory — historical/stale is never relabeled live.
router.get("/admin/market-data/candle-depth", async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const symbol = typeof req.query.symbol === "string" ? req.query.symbol.trim() : "";
  if (!symbol) {
    res.status(400).json({ error: "SYMBOL_REQUIRED", message: "A symbol query param is required." });
    return;
  }

  try {
    const report = await buildCandleDepthReport(symbol);
    res.json({ ok: true, report });
  } catch (err) {
    req.log.error({ err, symbol }, "candle-depth diagnostics failed");
    res.status(500).json({
      error: "DEPTH_PROBE_FAILED",
      message: String((err as Error).message ?? err).slice(0, 280),
    });
  }
});

// GET /api/admin/market-data/broker-candles?symbol=EURUSD
//
// Durable broker_candles coverage + backfill status (Task #470). Returns one
// row per (bridge, broker symbol, timeframe) series showing how deep the
// EA-pushed history is, the backfill state-machine status, and how many bars
// are actually mirrored into the router-read mt5_broker cache slot (what the
// chart/Scanner would prefer when fresh + sufficient).
//
// Read-only market-data telemetry. Touches no execution path, no arx_live_*
// table, no balance/fill, and no safety gate. Optional ?symbol= narrows to one
// symbol; never fabricates — reports exactly what is stored.
router.get("/admin/market-data/broker-candles", async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const symbol = typeof req.query.symbol === "string" ? req.query.symbol.trim() : "";

  try {
    const coverage = await getBrokerCandleCoverage(symbol ? { symbol } : undefined);
    // Task #500 — surface body-parser rejections on the EA ingest routes so an
    // operator can see at a glance whether the candle feed is silently dropping
    // batches at the parser (413/parse-failure BEFORE the handler runs). The
    // counter is in-memory and RESETS on server restart, consistent with the
    // other bridge telemetry counters.
    res.json({
      ok: true,
      coverage,
      ingestRejections: getIngestRejections(),
      ingestRejectionsNote:
        "Body-parser rejections (413 too-large / parse failures) on EA ingest routes. In-memory — resets on server restart.",
    });
  } catch (err) {
    req.log.error({ err, symbol }, "broker-candle coverage diagnostics failed");
    res.status(500).json({
      error: "BROKER_COVERAGE_FAILED",
      message: String((err as Error).message ?? err).slice(0, 280),
    });
  }
});

// GET /api/admin/market-data/economic-calendar
//
// Operator diagnostics for the economic-calendar provider (Trading Economics).
// Returns the honest health snapshot: provider name, whether it is configured,
// whether an API key is present (BOOLEAN only — the raw key/secret is NEVER
// returned), the current status (ok|empty|missing|error), last fetch/success
// timestamps, last error string, event count, freshness, and cache age.
//
// Read-only telemetry. Touches no execution path, no arx_live_* table, no
// balance/fill, and no safety gate.
router.get("/admin/market-data/economic-calendar", async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  try {
    const diagnostics = await getEconomicCalendarDiagnostics();
    res.json({ ok: true, diagnostics });
  } catch (err) {
    req.log.error({ err }, "economic-calendar diagnostics failed");
    res.status(500).json({
      error: "CALENDAR_DIAGNOSTICS_FAILED",
      message: String((err as Error).message ?? err).slice(0, 280),
    });
  }
});

// GET /api/admin/market-data/distribution-ood/:symbol
//
// Distribution-level OOD diagnostics (capability #3): compares the live tail
// window of the symbol's own candle/spread history against reference
// distributions certified from the older part of that same history
// (PSI + KS via the pure continuous-validation engine).
//
// ADVISORY ONLY — the verdict carries advisoryOnly:true, is not a gate key,
// and no execution path consults it. Thin history returns the engine's typed
// insufficiency statuses; a failed read returns a typed UNREADABLE report —
// never a fabricated verdict. Read-only telemetry: touches no execution path,
// no arx_live_* table, no balance/fill, and no safety gate.
router.get("/admin/market-data/distribution-ood/:symbol", async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const symbol = String(req.params.symbol ?? "").trim();
  if (!symbol || symbol.length > 64) {
    res.status(400).json({ error: "INVALID_SYMBOL" });
    return;
  }
  const rawTf = typeof req.query.timeframe === "string" ? req.query.timeframe.trim() : "M15";
  const timeframe = /^(M1|M5|M15|M30|H1|H4|D1)$/.test(rawTf) ? rawTf : "M15";

  try {
    res.json({ ok: true, report: evaluateLiveDistributionOod(symbol, timeframe) });
  } catch (err) {
    req.log.error({ err, symbol }, "distribution-ood diagnostics failed");
    res.status(500).json({
      error: "DISTRIBUTION_OOD_FAILED",
      message: String((err as Error).message ?? err).slice(0, 280),
    });
  }
});

export default router;

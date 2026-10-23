// Market Scanner / Opportunity / Session Plan / Decision Stream / Alerts HTTP.
//
// SAFETY: Scanner is read-only over the simulator. The always-on engine
// (start/stop) and alert actions require ADMIN; the one-shot manual scan is
// open to any authenticated user (rate-limited, per-viewer-projected). Nothing
// here touches live_positions, mt5_commands, or placeLiveOrderGuarded().
import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod/v4";
import { readRoleFromRequest } from "../lib/security/middleware.js";
import {
  scanOnce, scannerStart, scannerStop, scannerStatus, scannerOpportunities,
  opportunityScore, sessionPlan, decisionStream, listAlerts, alertAction, alertCount,
  decorateOpportunitiesWithHistory, decorateOpportunitiesWithNewsRisk,
  decorateOpportunitiesWithFinalRead, decorateOpportunitiesWithTimingContext,
  decorateOpportunitiesWithFvgRead,
  effectiveOpportunityScore,
  DEFAULT_SYMBOLS, DEFAULT_TIMEFRAMES, UNIVERSES, UNIVERSE_IDS, type UniverseId,
} from "../lib/marketScanner.js";
import {
  projectOpportunitiesForViewer,
  viewerSeesSimulatorDetail,
  maskSimulatorMarketAnalysis,
  maskSimulatorTradeCard,
  maskSimulatorOpportunityScore,
  maskSimulatorSessionPlan,
} from "../lib/honesty/feedTruthCopy.js";
import { requireUser } from "../lib/auth/middleware.js";
import { consumeRateLimit, hashScope } from "../lib/security/cooldowns.js";
import { resolveArxMarket, isApprovedArxMarket, ARX_FOCUS_BLOCKED_REASON } from "@workspace/domain/market";
import {
  isScannerOutageArmed,
  isScannerOutageInjectionAllowed,
  setScannerOutageArmed,
} from "../lib/devScannerOutage.js";
import { analyzeMarket, generateTradeCard } from "../lib/aiBrain.js";
import { getSelectedMarketSnapshot } from "../lib/scannerSelected/selectedMarket.js";
import { ALL_SUPPORTED_SYMBOLS, normalizeSymbol } from "../lib/scannerSelected/symbolNormalize.js";

const router = Router();

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const role = readRoleFromRequest(req);
  if (role !== "ADMIN" && role !== "OWNER") {
    res.status(403).json({ error: "Forbidden", requiredRole: "ADMIN" });
    return;
  }
  next();
}

// ── Scanner ────────────────────────────────────────────────────────────────
// Dev-only outage injection. When armed (non-production only), the two
// read-only scanner feeds answer with a BODY-LESS 502 so QA can confirm the
// honest page-scope degraded banner on every tab. Disabled and inert in
// production — see lib/devScannerOutage.ts.
router.get("/market-scanner/status", (_req, res) => {
  if (isScannerOutageArmed()) return res.status(502).end();
  return res.json(scannerStatus());
});

// Dev-only: read + toggle the simulated scanner outage. 404s where injection is
// not allowed (production) so the surface simply does not exist there. Requires
// an authenticated session via the global gate; no admin role needed because the
// non-prod env gate is the real protection and any signed-in QA user must be
// able to flip it during a live test.
router.get("/market-scanner/__dev/outage", (_req, res) => {
  if (!isScannerOutageInjectionAllowed()) return res.status(404).json({ error: "Not found" });
  return res.json({ armed: isScannerOutageArmed() });
});
router.post("/market-scanner/__dev/outage", (req, res) => {
  if (!isScannerOutageInjectionAllowed()) return res.status(404).json({ error: "Not found" });
  const Body = z.object({ armed: z.boolean() });
  const p = Body.safeParse(req.body ?? {});
  if (!p.success) return res.status(400).json({ error: "armed (boolean) required" });
  const armed = setScannerOutageArmed(p.data.armed);
  req.log.warn({ action: "SCANNER_OUTAGE_INJECTION_TOGGLE", armed }, "scanner.dev_outage");
  return res.json({ armed });
});

router.get("/market-scanner/opportunities", async (req, res) => {
  if (isScannerOutageArmed()) return res.status(502).end();
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const status = scannerStatus();
  const base = scannerOpportunities(limit);
  const withHistory = await decorateOpportunitiesWithHistory(base);
  const withNews = await decorateOpportunitiesWithNewsRisk(withHistory);
  const withTiming = await decorateOpportunitiesWithTimingContext(withNews);
  const withFvg = await decorateOpportunitiesWithFvgRead(withTiming);
  // Re-sort after timing boost so displayed order reflects heat-adjusted scores.
  withFvg.sort((a, b) => effectiveOpportunityScore(b) - effectiveOpportunityScore(a));
  const decorated = decorateOpportunitiesWithFinalRead(withFvg);
  // Non-admin/owner viewers never see simulator-derived indicator values:
  // simulator rows are masked to an honest "Waiting for verified feed" state.
  const projected = projectOpportunitiesForViewer(decorated, readRoleFromRequest(req));
  return res.json({
    opportunities: projected,
    universe: status.universe,
    universeSymbols: status.universeSymbols,
    defaults: { symbols: DEFAULT_SYMBOLS, timeframes: DEFAULT_TIMEFRAMES },
    // Envelope-level dataSource is informational only; the authoritative
    // per-opportunity tag is on each row's `dataSource`/`feedProvider`
    // (LIVE_FEED | AWAITING_FEED | SIMULATOR). The scanner routes every
    // symbol through the unified Market Data Router first, so the
    // envelope is labelled "ROUTER" rather than the legacy "SIMULATOR".
    dataSource: "ROUTER",
    feedNote: status.feedNote,
  });
});

router.get("/market-scanner/universes", (_req, res) => {
  return res.json({
    universes: UNIVERSE_IDS.map((id) => ({
      id,
      label: ({
        all: "Core Markets", forex: "Forex", metals: "Metals",
        indices: "Indices", crypto: "Crypto", synthetic: "Synthetic Indices",
        full: "All Approved Markets",
      } as const)[id],
      symbols: UNIVERSES[id],
      available: UNIVERSES[id].length > 0,
      note: id === "synthetic"
        ? "Volatility / Boom / Crash indices need a live broker feed (Deriv or MT5)."
        : null,
    })),
    dataSource: "SIMULATOR",
  });
});

const UniverseEnum = z.enum(UNIVERSE_IDS as [UniverseId, ...UniverseId[]]);

router.post("/market-scanner/start", requireAdmin, (req, res) => {
  const Body = z.object({
    intervalMs: z.number().int().min(1000).optional(),
    universe: UniverseEnum.optional(),
  });
  const p = Body.safeParse(req.body ?? {});
  return res.json(scannerStart(p.success ? p.data : {}));
});

router.post("/market-scanner/stop", requireAdmin, (_req, res) => res.json(scannerStop()));

// Task #562 — the one-shot manual Broad Scan is open to EVERY authenticated
// user (not just operators), protected by a per-user cooldown. The always-on
// engine (start/stop) stays operator-only above. This stays a read-only
// discovery surface: the per-viewer projection + bounded enrichment below are
// unchanged, so a normal user never sees simulator-derived/privileged fields.
router.post("/market-scanner/scan", requireUser, async (req, res) => {
  // Durable per-user manual-scan cooldown, backed by the DB limiter
  // (security_cooldowns) via the MANUAL_SCAN policy. Unlike the prior in-memory
  // limiter (which reset on restart and split per node), this throttle survives
  // server restarts AND is shared across horizontally-scaled instances. The 429
  // envelope is byte-identical to the original so the Scan-button countdown
  // keeps reading `retryAfterMs`.
  const cooldown = await consumeRateLimit("MANUAL_SCAN", hashScope("manual_scan", String(req.authUser!.id)));
  if (!cooldown.allowed) {
    return res.status(429).json({
      ok: false,
      reason: "SCAN_RATE_LIMITED",
      retryAfterMs: cooldown.retryAfterMs,
    });
  }
  const Body = z.object({
    symbols: z.array(z.string()).optional(),
    timeframes: z.array(z.string()).optional(),
    universe: UniverseEnum.optional(),
  });
  const p = Body.safeParse(req.body ?? {});
  // Task #558 — ARX Focus backstop (additive): even an explicit admin symbol list
  // is filtered to approved markets before scanning. The default universe already
  // derives from the registry; this guards the explicit-list path too.
  const scanArgs = p.success ? { ...p.data } : {};
  if (scanArgs.symbols) scanArgs.symbols = scanArgs.symbols.filter((s) => isApprovedArxMarket(s));
  const opps = await scanOnce(scanArgs);
  const withHistory = await decorateOpportunitiesWithHistory(opps);
  const withNews = await decorateOpportunitiesWithNewsRisk(withHistory);
  const withTiming = await decorateOpportunitiesWithTimingContext(withNews);
  const withFvg = await decorateOpportunitiesWithFvgRead(withTiming);
  // Re-sort after timing boost so displayed order reflects heat-adjusted scores.
  withFvg.sort((a, b) => effectiveOpportunityScore(b) - effectiveOpportunityScore(a));
  const decorated = decorateOpportunitiesWithFinalRead(withFvg);
  // Non-admin/owner viewers never see simulator-derived indicator values.
  const projected = projectOpportunitiesForViewer(decorated, readRoleFromRequest(req));
  const status = scannerStatus();
  return res.json({
    opportunities: projected,
    count: projected.length,
    universe: status.universe,
    universeSymbols: status.universeSymbols,
    // Envelope tag — per-opportunity dataSource on each row is authoritative.
    dataSource: "ROUTER",
    feedNote: status.feedNote,
  });
});

// ── AI helpers ─────────────────────────────────────────────────────────────
// SAFETY (Task #573): these three reads are 100% simulator-derived scored
// analysis. They obey the SAME role gate as the scanner rows above
// (viewerSeesSimulatorDetail(readRoleFromRequest(req))) — ADMIN/OWNER see full
// simulator detail; everyone else gets the scores withheld behind the honest
// "Waiting for verified feed" state. No live data is ever masked here.
router.post("/ai/opportunity-score", (req, res) => {
  const Body = z.object({ symbol: z.string(), timeframe: z.string().optional(), strategyMatch: z.number().optional() });
  const p = Body.safeParse(req.body ?? {});
  if (!p.success) return res.status(400).json({ error: "symbol required" });
  const a = analyzeMarket(p.data.symbol, p.data.timeframe);
  const opp = opportunityScore(a, p.data.strategyMatch ?? 7);
  const projected = viewerSeesSimulatorDetail(readRoleFromRequest(req)) ? opp : maskSimulatorOpportunityScore(opp);
  return res.json({ ...projected, symbol: p.data.symbol, timeframe: a.timeframe, dataSource: "SIMULATOR" });
});

router.post("/ai/setup-analysis", (req, res) => {
  const Body = z.object({ symbol: z.string(), timeframe: z.string().optional() });
  const p = Body.safeParse(req.body ?? {});
  if (!p.success) return res.status(400).json({ error: "symbol required" });
  const a = analyzeMarket(p.data.symbol, p.data.timeframe);
  const opp = opportunityScore(a);
  const card = generateTradeCard(p.data.symbol, p.data.timeframe);
  if (viewerSeesSimulatorDetail(readRoleFromRequest(req))) {
    return res.json({ analysis: a, opportunity: opp, card, dataSource: "SIMULATOR" });
  }
  return res.json({
    analysis: maskSimulatorMarketAnalysis(a),
    opportunity: maskSimulatorOpportunityScore(opp),
    card: maskSimulatorTradeCard(card),
    dataSource: "SIMULATOR",
    withheld: true,
  });
});

router.post("/ai/session-plan", async (req, res) => {
  const plan = await sessionPlan();
  return res.json(viewerSeesSimulatorDetail(readRoleFromRequest(req)) ? plan : maskSimulatorSessionPlan(plan));
});
router.get("/ai/session-plan", async (req, res) => {
  const plan = await sessionPlan();
  return res.json(viewerSeesSimulatorDetail(readRoleFromRequest(req)) ? plan : maskSimulatorSessionPlan(plan));
});

// ── Decision stream ────────────────────────────────────────────────────────
router.get("/decision-stream", (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  return res.json({ decisions: decisionStream(limit), dataSource: "SIMULATOR" });
});

// ── Alert engine (in-memory; coexists with persistent /api/alerts) ─────────
router.get("/alerts/scanner", (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 200);
  const unackedOnly = req.query.unackedOnly === "true";
  return res.json({
    alerts: listAlerts({ limit, unackedOnly }),
    count: alertCount(),
    dataSource: "SIMULATOR",
  });
});

router.post("/alerts/acknowledge", requireAdmin, (req, res) => {
  const Body = z.object({ alertId: z.string() });
  const p = Body.safeParse(req.body ?? {});
  if (!p.success) return res.status(400).json({ error: "alertId required" });
  const a = alertAction(p.data.alertId, "acknowledge");
  if (!a) return res.status(404).json({ error: "alert not found" });
  return res.json(a);
});

router.post("/alerts/dismiss", requireAdmin, (req, res) => {
  const Body = z.object({ alertId: z.string() });
  const p = Body.safeParse(req.body ?? {});
  if (!p.success) return res.status(400).json({ error: "alertId required" });
  const a = alertAction(p.data.alertId, "dismiss");
  if (!a) return res.status(404).json({ error: "alert not found" });
  return res.json(a);
});

router.post("/alerts/snooze", requireAdmin, (req, res) => {
  const Body = z.object({ alertId: z.string(), minutes: z.number().int().min(1).max(120).optional() });
  const p = Body.safeParse(req.body ?? {});
  if (!p.success) return res.status(400).json({ error: "alertId required" });
  const a = alertAction(p.data.alertId, "snooze", (p.data.minutes ?? 10) * 60_000);
  if (!a) return res.status(404).json({ error: "alert not found" });
  return res.json(a);
});

// ── Selected-market panel ──────────────────────────────────────────────────
// SAFETY: read-only over the simulator + economic_events table. Never
// dispatches a trade. Output is user-facing language only — no secrets,
// no bridge tokens, no raw event IDs are exposed beyond their public
// externalId.
router.get("/market-scanner/supported-symbols", (_req, res) => {
  return res.json({
    supported: ALL_SUPPORTED_SYMBOLS,
    suggestions: ["EURUSD", "GBPUSD", "XAUUSD", "US30", "NAS100", "BTCUSDT", "TSLA", "V75"],
    dataSource: "SIMULATOR",
  });
});

router.get("/market-scanner/selected-market", async (req, res) => {
  const rawSymbol = String(req.query.symbol ?? "").trim();
  const timeframe = (typeof req.query.timeframe === "string" ? req.query.timeframe : "M15") || "M15";
  const refresh = req.query.refresh === "true" || req.query.refresh === "1";
  if (!rawSymbol) {
    return res.status(400).json({
      ok: false,
      error: "SYMBOL_REQUIRED",
      message: "Type a symbol like EURUSD, XAUUSD, or US30.",
    });
  }
  // Task #558 — ARX Focus backstop (additive): refuse selected-market reads for
  // any symbol outside the approved universe with an honest blocked envelope and
  // NO market data. Position management is unaffected (this is a read surface).
  if (!resolveArxMarket(rawSymbol)) {
    return res.status(200).json({
      ok: false,
      error: "SYMBOL_NOT_IN_ARX_FOCUS",
      requestedSymbol: rawSymbol,
      isApprovedMarket: false,
      blocked: true,
      reason: ARX_FOCUS_BLOCKED_REASON,
    });
  }
  try {
    const snapshot = await getSelectedMarketSnapshot({ symbolRaw: rawSymbol, timeframe, refresh });
    const normalized = normalizeSymbol(rawSymbol);
    req.log.info({
      action: refresh ? "SCANNER_SELECTED_SYMBOL_REFRESH" : "SCANNER_SELECTED_SYMBOL_VIEW",
      symbolRaw: rawSymbol, symbol: normalized, timeframe,
      ok: snapshot.ok, cacheHit: snapshot.ok ? snapshot.cacheHit : false,
    }, "scanner.selected_market");
    return res.json(snapshot);
  } catch (err) {
    req.log.error({ err: String(err), symbolRaw: rawSymbol }, "scanner.selected_market failed");
    return res.status(500).json({
      ok: false, error: "SELECTED_MARKET_UNAVAILABLE",
      message: "We couldn't load this market right now. Try again.",
    });
  }
});

export default router;

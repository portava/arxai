// Build QQ — Unified Trading Cockpit (read-only aggregator).
//
// SAFETY: Read-only. Never places trades, never enables live trading, never
// calls MT5, never modifies canPlaceTrades, never exposes secrets, never
// recommends live trading. Aggregates existing safe AA-PP service outputs
// into one envelope for the cockpit UI.

import { Router, type IRouter } from "express";
import { db, paperOrdersTable } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { preflight, getActiveSession } from "../lib/paperSession/manager.js";
import { evaluateGovernor } from "../lib/riskGovernor/governor.js";
import { getGateStatus } from "../lib/readiness/gate.js";
import { getCriticalUnread, getUnreadCount } from "../lib/alerts/alertManager.js";
import { scrub } from "../lib/security/redact.js";
import { runHealthCheck } from "../lib/systemHealth/health.js";
import { logger } from "../lib/logger.js";
import { requireUser } from "../lib/auth/middleware.js";
import { getMarketData } from "../lib/marketData/marketDataService.js";
import type { MarketDataSnapshot } from "../lib/marketData/types.js";
import { unrealizedPnl } from "../lib/paperExecution/paperExecutionMonitor.js";

const router: IRouter = Router();

// ── Open-trade unrealized P&L ───────────────────────────────────────────────
// paper_orders.profit_loss is written ONLY at close; for OPEN rows it is the
// schema default 0, so surfacing it showed every open position — however deep
// underwater — as flat, in neutral color, for its entire open life. Open rows
// are instead priced here against a fresh Build DD quote at read time. When no
// honest quote exists the P&L degrades to a typed null WITH the reason —
// never a confident 0.
const MAX_PRICING_QUOTE_AGE_MS = 60_000; // matches Build DD's stale threshold

export interface OpenTradeUnrealizedPnl {
  value: number | null;
  asOf: string | null;
  source: string | null;
  quality: string | null;
  /** Set ONLY when value is null — why this trade could not be priced. */
  reason: string | null;
  /**
   * Always "SIM_POINTS". The paper P&L formula is dir × (price − entry) ×
   * lotSize × 100, symbol-blind — no contract size, pip value, or per-symbol
   * scaling — so the figure corresponds to no real currency amount. Surfaces
   * rendering it must label it sim pts, never dollars or cents.
   */
  unit: "SIM_POINTS";
}

export function priceOpenTrade(
  order: { direction: string; lotSize: number; entryPrice: number },
  snap: Pick<MarketDataSnapshot, "mid" | "source" | "timestamp" | "dataQuality"> | null,
  nowMs: number,
): OpenTradeUnrealizedPnl {
  if (!snap) {
    return { value: null, asOf: null, source: null, quality: null, reason: "market data read failed", unit: "SIM_POINTS" };
  }
  const quality = snap.dataQuality.status;
  if (!Number.isFinite(snap.mid) || quality === "MISSING") {
    return {
      value: null, asOf: null, source: snap.source, quality,
      reason: snap.dataQuality.warnings[0] ?? "no usable quote for this symbol",
      unit: "SIM_POINTS",
    };
  }
  if (quality === "SYNTHETIC" || snap.source !== "REAL") {
    return {
      value: null, asOf: snap.timestamp, source: snap.source, quality,
      reason: `quote source is ${snap.source}/${quality}, not a real provider — refusing to price against fabricated data`,
      unit: "SIM_POINTS",
    };
  }
  const ageMs = nowMs - new Date(snap.timestamp).getTime();
  if (!Number.isFinite(ageMs) || ageMs > MAX_PRICING_QUOTE_AGE_MS) {
    return {
      value: null, asOf: snap.timestamp, source: snap.source, quality,
      reason: `quote is ${Math.round(ageMs / 1000)}s old (max ${MAX_PRICING_QUOTE_AGE_MS / 1000}s) — refusing to price against a stale quote`,
      unit: "SIM_POINTS",
    };
  }
  return {
    value: Number(unrealizedPnl(order.direction, order.lotSize, order.entryPrice, snap.mid).toFixed(2)),
    asOf: snap.timestamp, source: snap.source, quality, reason: null, unit: "SIM_POINTS",
  };
}

// ── Today's performance ─────────────────────────────────────────────────────
// Build EE-owned orders are settled by the EE monitor against Build DD market
// data; every OTHER paper order (Build Q sandbox) is entered/settled/closed
// against the seeded deterministic candle generator — a PRNG, not the market.
// Those mock-settled closes are counted, but the count is surfaced so the UI
// can say the total includes synthetic-priced closes instead of presenting a
// PRNG outcome as a market outcome.
const EE_STRATEGY_ID = "build_ee_paper_execution";

export interface TodayPerformance {
  totalTrades: number | null;
  wins: number | null;
  losses: number | null;
  breakEven: number | null;
  netPnl: number | null;
  winRate: number | null;
  dayRating: string;
  /** See OpenTradeUnrealizedPnl.unit — paper P&L is symbol-blind sim points, not currency. */
  pnlUnit: "SIM_POINTS";
  /** How many of today's closes were settled by the synthetic price model (non-EE orders). */
  syntheticPricedTrades: number | null;
  /**
   * The fill assumption behind every SL/TP-settled row inside these totals.
   * Both settlers (paperExecutionMonitor and paperTrading's mark-to-market)
   * close at EXACTLY the stop/target level even when the observed price has
   * already run past it, so realized P&L is an optimistic bound — a real gap
   * through the level would fill worse. Not a measurement, so it holds on a
   * failed read too. Surfaces rendering netPnl/winRate must disclose it.
   */
  fillModel: "STOP_AND_TARGET_FILL_AT_LEVEL_NO_GAP_OR_SLIPPAGE";
  /** Plain-language form of `fillModel`, for direct rendering. */
  fillModelNote: string;
  readFailed: boolean;
  readFailedReason: string | null;
}

const FILL_MODEL = "STOP_AND_TARGET_FILL_AT_LEVEL_NO_GAP_OR_SLIPPAGE" as const;
const FILL_MODEL_NOTE =
  "Closes fill at exactly the stop/target level — gaps and slippage are not modelled, so these results are an optimistic bound, not a measured outcome.";

// A failed paper_orders read is NOT a flat day. The old fallback was
// {totalTrades:0, ..., netPnl:0, dayRating:'NO_TRADES'}, which rendered the
// same confident "No closed paper trades yet today" copy for a DB outage as
// for genuinely being flat. Counts become typed nulls with the reason instead.
export const TODAY_PERFORMANCE_READ_FAILED: TodayPerformance = {
  totalTrades: null, wins: null, losses: null, breakEven: null,
  netPnl: null, winRate: null,
  dayRating: "UNKNOWN",
  pnlUnit: "SIM_POINTS",
  syntheticPricedTrades: null,
  fillModel: FILL_MODEL,
  fillModelNote: FILL_MODEL_NOTE,
  readFailed: true,
  readFailedReason: "The paper-orders read failed — today's results are unknown, not zero.",
};

export function summarizeTodayPerformance(
  closedToday: Array<{ profitLoss: number | null; strategyId: string | null }>,
): TodayPerformance {
  const wins = closedToday.filter(r => (r.profitLoss ?? 0) > 0).length;
  const losses = closedToday.filter(r => (r.profitLoss ?? 0) < 0).length;
  const breakEven = closedToday.filter(r => (r.profitLoss ?? 0) === 0).length;
  const netPnl = closedToday.reduce((s, r) => s + (r.profitLoss ?? 0), 0);
  const totalTrades = closedToday.length;
  const winRate = totalTrades > 0 ? Math.round((wins / totalTrades) * 100) : 0;
  const dayRating = totalTrades === 0 ? "NO_TRADES" : netPnl > 0 ? "GREEN" : netPnl < 0 ? "RED" : "FLAT";
  const syntheticPricedTrades = closedToday.filter(r => r.strategyId !== EE_STRATEGY_ID).length;
  return {
    totalTrades, wins, losses, breakEven, netPnl, winRate, dayRating,
    pnlUnit: "SIM_POINTS",
    syntheticPricedTrades,
    fillModel: FILL_MODEL,
    fillModelNote: FILL_MODEL_NOTE,
    readFailed: false,
    readFailedReason: null,
  };
}

const DISCLAIMER = "Build QQ — Unified Trading Cockpit. Read-only aggregator. Never places trades, never enables live trading, never calls MT5, never modifies canPlaceTrades, never exposes secrets, never recommends live trading.";

function envelope(payload: Record<string, unknown>) {
  return {
    system: "trading-cockpit",
    appMode: "PAPER_ONLY" as const,
    liveTradingStatus: "DISABLED" as const,
    mode: "PAPER_ONLY" as const,
    canPlaceLiveTrade: false,
    canProceedToLiveTrading: false,
    disclaimer: DISCLAIMER,
    ...payload,
  };
}

async function safeCall<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); } catch (e) {
    logger.warn({ label, err: String(e).slice(0, 200) }, "cockpit: subsystem read failed");
    return fallback;
  }
}

function pickNextBestAction(args: {
  blockers: string[];
  hasActive: boolean;
  sessionStatus: string | null;
  criticalUnread: number;
  alertsReadFailed: boolean;
  paperTestingAllowed: boolean;
}): { code: string; label: string; cta: string; severity: "INFO" | "WARN" | "BLOCK" } {
  if (args.criticalUnread > 0) return { code: "ACK_CRITICAL", label: "Acknowledge critical safety alert(s)", cta: "Open Notifications", severity: "BLOCK" };
  // FAIL CLOSED: an unreadable alert store is NOT an all-clear. If we cannot
  // know whether a critical alert exists, starting a session must stay gated,
  // exactly as it would be with an unacknowledged critical alert.
  if (args.alertsReadFailed) return { code: "ALERTS_UNREADABLE", label: "Alert status could not be read — start is blocked until alerts are readable", cta: "Open Notifications", severity: "BLOCK" };
  if (!args.paperTestingAllowed) return { code: "PREFLIGHT_BLOCKED", label: `Preflight blocked: ${args.blockers.slice(0, 2).join("; ") || "see details"}`, cta: "Run Preflight", severity: "BLOCK" };
  if (args.hasActive && args.sessionStatus === "PAUSED") return { code: "RESUME", label: "Resume your paused paper session", cta: "Resume Session", severity: "INFO" };
  if (args.hasActive && args.sessionStatus === "ACTIVE") return { code: "MONITOR", label: "Monitor your active paper session", cta: "Open Active Session", severity: "INFO" };
  return { code: "START", label: "Safe to start a new paper session", cta: "Start Paper Session", severity: "INFO" };
}

router.get("/trading-cockpit/summary", requireUser, async (req, res) => {
  const generatedAt = new Date().toISOString();
  // Per-user isolation: the cockpit shows THIS trader's active paper session
  // and THIS trader's governor. It used to read whichever ACTIVE session and
  // whichever risk-settings row existed on the instance.
  const userId = req.authUser!.id;

  const preFallback = { paperTestingAllowed: false, hardBlocks: [{ source: "QQ", code: "PREFLIGHT_ERROR", message: "preflight unavailable" }], warnings: [] as { source: string; code: string; message: string }[], generatedAt } as unknown as Awaited<ReturnType<typeof preflight>>;
  // Alert reads must NOT swallow failures into all-clear values ([] / 0):
  // that made a broken alert store indistinguishable from "no alerts", hid
  // the critical banner, and let the ACK_CRITICAL gate silently pass. Wrap
  // them so a failed read stays a typed unknown, never a confident zero.
  type AlertRead<T> = { ok: boolean; value: T };
  const criticalFallback: AlertRead<Awaited<ReturnType<typeof getCriticalUnread>>> = { ok: false, value: [] };
  const unreadFallback: AlertRead<number> = { ok: false, value: 0 };
  const [pre, active, gov, gate, criticalRead, unreadRead] = await Promise.all([
    safeCall("preflight", () => preflight(userId), preFallback),
    safeCall("activeSession", () => getActiveSession(userId), null),
    safeCall("governor", () => evaluateGovernor({ userId }), null),
    safeCall("readinessGate", () => getGateStatus(), null as Awaited<ReturnType<typeof getGateStatus>> | null),
    safeCall("criticalUnread", async () => ({ ok: true, value: await getCriticalUnread() }), criticalFallback),
    safeCall("unreadAll", async () => ({ ok: true, value: await getUnreadCount() }), unreadFallback),
  ]);
  const criticalUnread = criticalRead.value;
  const alertsReadFailed = !criticalRead.ok || !unreadRead.ok;

  // Open paper trades from EE (read-only). NOTE: profit_loss is deliberately
  // NOT selected — for OPEN rows it is the write-at-close column's DB default
  // 0, and rendering it showed every open position as flat. Open rows are
  // priced against a fresh DD quote below instead.
  //
  // Scoped to THIS user (the route's whole claim is per-user isolation):
  // unscoped, this panel presented every other account's open trades as this
  // trader's. Legacy rows with a NULL user_id cannot be attributed to anyone
  // and are honestly excluded — same rule the session accounting applies —
  // rather than guessed onto whoever is looking.
  //
  // A failed read is a typed failure, not an empty list: the old fallback []
  // made a DB outage render as the confident "No open paper trades" copy.
  type OpenTradesRead = { ok: boolean; rows: Array<{ id: number; symbol: string; direction: string; lotSize: number; entryPrice: number; stopLoss: number; takeProfit: number; status: string; openedAt: Date }> };
  const openTradesRead = await safeCall<OpenTradesRead>("openPaperTrades", async () => {
    const rows = await db.select({
      id: paperOrdersTable.id,
      symbol: paperOrdersTable.symbol,
      direction: paperOrdersTable.direction,
      lotSize: paperOrdersTable.lotSize,
      entryPrice: paperOrdersTable.entryPrice,
      stopLoss: paperOrdersTable.stopLoss,
      takeProfit: paperOrdersTable.takeProfit,
      status: paperOrdersTable.status,
      openedAt: paperOrdersTable.openedAt,
    }).from(paperOrdersTable)
      .where(and(eq(paperOrdersTable.status, "OPEN"), eq(paperOrdersTable.userId, userId)))
      .orderBy(desc(paperOrdersTable.openedAt)).limit(20);
    return { ok: true, rows };
  }, { ok: false, rows: [] });
  const openRows = openTradesRead.rows;

  // One quote per distinct symbol; each open row is then priced or given a
  // typed null + reason. getMarketData already degrades honestly (empty
  // snapshot with MISSING quality + reason) instead of throwing.
  const quoteBySymbol = new Map<string, MarketDataSnapshot | null>();
  for (const sym of new Set(openRows.map(o => o.symbol))) {
    try {
      const { snapshot } = await getMarketData({ symbol: sym, timeframe: "M5", limit: 10 });
      quoteBySymbol.set(sym, snapshot);
    } catch (e) {
      logger.warn({ symbol: sym, err: String(e).slice(0, 160) }, "cockpit: open-trade quote read failed");
      quoteBySymbol.set(sym, null);
    }
  }
  const pricedAtMs = Date.now();
  const openTrades = openRows.map(o => ({
    ...o,
    unrealizedPnl: priceOpenTrade(o, quoteBySymbol.get(o.symbol) ?? null, pricedAtMs),
  }));

  // Today's performance (light aggregate from THIS user's paper orders closed
  // today — the unscoped select().from() here summed every account's P&L into
  // one number presented as this trader's). NULL-user legacy rows are excluded
  // for the same attribution reason as the open-trades read above. A failed
  // read degrades to typed nulls + reason (TODAY_PERFORMANCE_READ_FAILED),
  // never the confident all-zero NO_TRADES shape.
  const todayPerformance = await safeCall("todayPerformance", async () => {
    const todayStart = new Date(); todayStart.setUTCHours(0, 0, 0, 0);
    const rows = await db.select().from(paperOrdersTable).where(eq(paperOrdersTable.userId, userId));
    const closedToday = rows.filter(r => r.closedAt && new Date(r.closedAt) >= todayStart);
    return summarizeTodayPerformance(closedToday);
  }, TODAY_PERFORMANCE_READ_FAILED);

  // Coach + autopilot derived from active session + risk governor; never live.
  const sessionRules = active?.sessionRules ?? null;
  const coachSummary = {
    mode: "PAPER_ONLY",
    liveTradingStatus: "DISABLED",
    dailyFocus: active?.sessionGoals?.mainGoal ?? "Practice high-quality paper setups before considering anything else.",
    mistakeToAvoid: active?.sessionGoals?.mistakeToAvoid ?? [],
    setupsToWatch: active?.sessionGoals?.setupsToWatch ?? [],
    setupsToAvoid: active?.sessionGoals?.setupsToAvoid ?? [],
    nextBestActions: active?.nextBestActions ?? ["Run preflight", "Start a paper session", "Debrief every closed trade"],
  };

  const autopilot = {
    mode: "PAPER_ONLY",
    liveTradingAllowed: false,
    allowedBySession: sessionRules?.allowPaperAutopilot ?? false,
    allowedByGovernor: gov?.autopilotAllowed ?? false,
    sessionStatus: active?.status ?? "NONE",
    cooldowns: gov?.cooldowns ?? [],
    note: active ? "Autopilot may run only while session is ACTIVE and rules allow it." : "No active paper session — autopilot is gated off.",
  };

  // System health: prefer cached governor + gate; only run full check if both missing.
  const gateStatus = gate?.currentStatus ?? null;
  const systemHealth = {
    overallHealth: gateStatus === "PASS" || gateStatus === "PASS_WITH_WARNINGS" ? "OK" : (gateStatus ?? "UNKNOWN"),
    readinessScore: gate?.readinessScore ?? null,
    readinessGrade: gate?.readinessGrade ?? null,
    lastReadinessAt: gate?.updatedAt ? new Date(gate.updatedAt).toISOString() : null,
    riskGovernorStatus: gov?.overallStatus ?? "UNKNOWN",
    majorWarnings: (gov?.softWarnings ?? []).slice(0, 5),
  };

  const blockers = pre.hardBlocks.map(b => `${b.source}:${b.code} — ${b.message}`);
  const nextBestAction = pickNextBestAction({
    blockers,
    hasActive: !!active,
    sessionStatus: active?.status ?? null,
    criticalUnread: criticalUnread.length,
    alertsReadFailed,
    paperTestingAllowed: pre.paperTestingAllowed,
  });

  const warnings: string[] = [
    ...pre.warnings.map(w => `${w.source}:${w.code} — ${w.message}`),
    ...(gov?.softWarnings?.map(w => `HH:${w.code} — ${w.message}`) ?? []),
  ];

  const cockpit_id = `cockpit_${Math.random().toString(36).slice(2, 10)}`;
  const summary = {
    cockpit_id,
    generated_at: generatedAt,
    mode: "PAPER_ONLY" as const,
    liveTradingStatus: "DISABLED" as const,
    canPlaceLiveTrade: false,
    canProceedToLiveTrading: false,
    readiness: gate ? {
      status: gate.currentStatus,
      score: gate.readinessScore,
      grade: gate.readinessGrade,
      paperTestingAllowed: gate.paperTestingAllowed,
      liveTradingAllowed: false,
      generatedAt: gate.updatedAt ? new Date(gate.updatedAt).toISOString() : null,
    } : { status: "UNKNOWN" },
    riskGovernor: gov ? {
      overallStatus: gov.overallStatus,
      paperTradingAllowed: gov.paperTradingAllowed,
      autopilotAllowed: gov.autopilotAllowed,
      manualPaperAllowed: gov.manualPaperAllowed,
      liveTradingAllowed: false,
      readinessScore: gov.readinessScore,
      readinessGrade: gov.readinessGrade,
      readinessLevel: gov.readinessLevel,
      hardBlocks: gov.hardBlocks ?? [],
      softWarnings: gov.softWarnings ?? [],
    } : { overallStatus: "UNKNOWN" },
    security: {
      rolesSeeded: pre.nn?.rolesSeeded ?? false,
      forbiddenLocked: pre.nn?.forbiddenLocked ?? false,
      secretsRedacted: "[REDACTED]",
    },
    activeSession: active ? {
      paper_session_id: active.paper_session_id,
      status: active.status,
      mode: active.mode,
      liveTradingStatus: active.liveTradingStatus,
      started_at: active.started_at,
      symbols: active.symbols,
      timeframes: active.timeframes,
      sessionRules: active.sessionRules,
      paperTradesOpened: active.paperTradesOpened,
      paperTradesClosed: active.paperTradesClosed,
      netPnl: active.netPnl,
      winRate: active.winRate,
      activeWarnings: active.activeWarnings,
    } : null,
    todayPerformance,
    openPaperTrades: openTrades,
    // Typed read failure — distinct from a genuinely-empty list, so the UI
    // can say "couldn't read" instead of "No open paper trades".
    openPaperTradesReadFailed: !openTradesRead.ok,
    openPaperTradesReadFailedReason: openTradesRead.ok
      ? null
      : "The paper-orders read failed — open trades are unknown, not zero.",
    coachSummary,
    notifications: {
      // Typed unknown on a failed read: counts become null (never 0) and the
      // reason travels with them, so the UI can render "?" + why instead of a
      // clean all-clear it has no evidence for.
      alertsReadFailed,
      alertsReadFailedReason: alertsReadFailed
        ? "The alert store could not be read — counts are unknown, not zero. Starting a session is blocked until this read succeeds."
        : null,
      unreadAll: unreadRead.ok ? unreadRead.value : null,
      criticalUnread: criticalRead.ok ? criticalUnread.length : null,
      // CROSS-USER LEAK, closed at the read surface. getCriticalUnread() filters
      // on read=0 and priority='CRITICAL' only — there is no user scope, because
      // no producer populates alerts.user_id (it exists and is always NULL; see
      // docs/API_SURFACE_JUSTIFICATIONS.md). With a live CRITICAL producer
      // (lib/fundbook/fundControls.ts:549), returning `title` and `message` here
      // handed one account's alert text — symbols, position ids, realised P/L —
      // to any other caller. Those two fields are now withheld.
      //
      // The count and the type remain system-wide facts shown to an individual
      // caller. That residue is stated in the payload rather than papered over,
      // and needs the per-user scoping work to close. Withholding the count too
      // would be a silent omission: the ACK_CRITICAL next-best-action depends on
      // it, and a real CRITICAL alert must not disappear.
      notificationScope: "SYSTEM_WIDE_UNSCOPED" as const,
      criticalSamples: criticalUnread.slice(0, 5).map(a => ({
        id: a.id,
        type: a.type,
        priority: a.priority,
        createdAt: a.createdAt,
        scope: "SYSTEM_WIDE_UNSCOPED" as const,
        detailWithheld: true as const,
        detailWithheldReason:
          "The alerts table is not scoped per user, so alert text is withheld here. Open Notifications for your own alerts.",
      })),
    },
    autopilot,
    systemHealth,
    nextBestAction,
    warnings,
  };

  res.json(envelope({ summary: scrub(summary) as Record<string, unknown> }));
});

router.get("/trading-cockpit/layout", (_req, res) => {
  res.json(envelope({
    layout: {
      defaultView: "compact",
      collapsedPanels: [],
      showAdvancedMetrics: false,
      panels: [
        { id: "safety", title: "Safety status", default: true },
        { id: "primaryAction", title: "Primary action", default: true },
        { id: "activeSession", title: "Active paper session", default: true },
        { id: "openTrades", title: "Open paper trades", default: true },
        { id: "today", title: "Today's performance", default: true },
        { id: "coach", title: "Coach guidance", default: true },
        { id: "alerts", title: "Alerts", default: true },
        { id: "autopilot", title: "Autopilot", default: true },
        { id: "health", title: "System health", default: true },
      ],
    },
  }));
});

router.post("/trading-cockpit/layout", (req, res) => {
  // Stateless layout echo — preferences are stored client-side (no DB rows).
  const body = (req.body ?? {}) as { collapsedPanels?: unknown; defaultView?: unknown; showAdvancedMetrics?: unknown };
  const collapsedPanels = Array.isArray(body.collapsedPanels) ? body.collapsedPanels.filter(p => typeof p === "string") : [];
  const defaultView = typeof body.defaultView === "string" ? body.defaultView : "compact";
  const showAdvancedMetrics = !!body.showAdvancedMetrics;
  res.json(envelope({ layout: { defaultView, collapsedPanels, showAdvancedMetrics, persisted: false, note: "Cockpit preferences are stored client-side; no DB rows are written." } }));
});

router.post("/trading-cockpit/demo", async (_req, res) => {
  res.json(envelope({
    demo: {
      panels: ["safety", "primaryAction", "activeSession", "openTrades", "today", "coach", "alerts", "autopilot", "health"],
      languageRules: ["DEMO_ONLY", "LIVE DISABLED", "READ_ONLY", "ACTIVE SESSION", "PAUSED SESSION", "BLOCKED", "TRADING PAUSED", "SAFE TO DEMO TEST", "ACTION REQUIRED"],
      forbiddenControls: ["live trade button", "enable live trading", "broker execution", "canPlaceTrades toggle"],
      note: "Demo only — does not start a session or place any trade.",
    },
  }));
});

// Diagnostic — confirm the cockpit can reach the underlying health subsystem.
router.get("/trading-cockpit/health-ping", async (_req, res) => {
  const r = await safeCall<{ ok: boolean; overall?: string; generatedAt?: string }>("healthCheck", async () => {
    const h = await runHealthCheck();
    return { ok: true, overall: h.overallStatus, generatedAt: h.generated_at };
  }, { ok: false });
  res.json(envelope({ healthPing: r }));
});

export default router;

// Build QQ — Unified Trading Cockpit (read-only aggregator).
//
// SAFETY: Read-only. Never places trades, never enables live trading, never
// calls MT5, never modifies canPlaceTrades, never exposes secrets, never
// recommends live trading. Aggregates existing safe AA-PP service outputs
// into one envelope for the cockpit UI.

import { Router, type IRouter } from "express";
import { db, paperOrdersTable } from "@workspace/db";
import { and, desc, eq, gte } from "drizzle-orm";
import { requireUser } from "../lib/auth/middleware.js";
import { preflight, getActiveSession } from "../lib/paperSession/manager.js";
import { evaluateReadiness } from "../lib/readiness/traderReadiness.js";
import { getGateStatus } from "../lib/readiness/gate.js";
import { getCriticalUnread, getUnreadCount } from "../lib/alerts/alertManager.js";
import { scrub } from "../lib/security/redact.js";
import { runHealthCheck } from "../lib/systemHealth/health.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

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
  paperTestingAllowed: boolean;
}): { code: string; label: string; cta: string; severity: "INFO" | "WARN" | "BLOCK" } {
  if (args.criticalUnread > 0) return { code: "ACK_CRITICAL", label: "Acknowledge critical safety alert(s)", cta: "Open Notifications", severity: "BLOCK" };
  if (!args.paperTestingAllowed) return { code: "PREFLIGHT_BLOCKED", label: `Preflight blocked: ${args.blockers.slice(0, 2).join("; ") || "see details"}`, cta: "Run Preflight", severity: "BLOCK" };
  if (args.hasActive && args.sessionStatus === "PAUSED") return { code: "RESUME", label: "Resume your paused paper session", cta: "Resume Session", severity: "INFO" };
  if (args.hasActive && args.sessionStatus === "ACTIVE") return { code: "MONITOR", label: "Monitor your active paper session", cta: "Open Active Session", severity: "INFO" };
  return { code: "START", label: "Safe to start a new paper session", cta: "Start Paper Session", severity: "INFO" };
}

// The cockpit shows the signed-in trader's own session and paper book.
router.get("/trading-cockpit/summary", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  const generatedAt = new Date().toISOString();

  const preFallback = { paperTestingAllowed: false, hardBlocks: [{ source: "QQ", code: "PREFLIGHT_ERROR", message: "preflight unavailable" }], warnings: [] as { source: string; code: string; message: string }[], generatedAt } as unknown as Awaited<ReturnType<typeof preflight>>;
  const [pre, active, gov, gate, criticalUnread, unreadAll] = await Promise.all([
    safeCall("preflight", () => preflight(), preFallback),
    safeCall("activeSession", () => getActiveSession(userId), null),
    safeCall("governor", () => evaluateReadiness({ persist: false, userId }), null),
    safeCall("readinessGate", () => getGateStatus(), null as Awaited<ReturnType<typeof getGateStatus>> | null),
    safeCall("criticalUnread", () => getCriticalUnread(userId), [] as Awaited<ReturnType<typeof getCriticalUnread>>),
    safeCall("unreadAll", () => getUnreadCount(userId), 0),
  ]);

  // Open paper trades from EE (read-only). paper_orders.profitLoss is written
  // only when an order closes (its column default is 0) and mark-to-market
  // folds floating P&L into the account's equity, not into the order row, so
  // an open order's P&L is not measured: it is returned as null, never as the
  // stored 0. A failed read is UNAVAILABLE, never an empty book.
  const openTradesRead = await safeCall("openPaperTrades", async () => {
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
      profitLoss: paperOrdersTable.profitLoss,
    }).from(paperOrdersTable).where(and(eq(paperOrdersTable.userId, userId), eq(paperOrdersTable.status, "OPEN"))).orderBy(desc(paperOrdersTable.openedAt)).limit(20);
    return rows.map(({ profitLoss: _storedDefault, openedAt, ...o }) => ({
      ...o,
      openedAt: openedAt ? new Date(openedAt).toISOString() : null,
      profitLoss: null,
      profitLossStatus: "NOT_MEASURED" as const,
    }));
  }, null);
  const openTrades = openTradesRead ?? [];
  const openPaperTradesStatus = openTradesRead ? "LOADED" as const : "UNAVAILABLE" as const;
  const OPEN_PAPER_TRADES_NOTE = "Floating P&L is not tracked per open order: the simulator adds it to the paper account's equity only. Each order's P&L is recorded when it closes.";

  // Today's performance (light aggregate from paper orders closed today).
  const todayPerformance = await safeCall("todayPerformance", async () => {
    const todayStart = new Date(); todayStart.setUTCHours(0, 0, 0, 0);
    const closedToday = await db.select().from(paperOrdersTable)
      .where(and(eq(paperOrdersTable.userId, userId), gte(paperOrdersTable.closedAt, todayStart)));
    const wins = closedToday.filter(r => (r.profitLoss ?? 0) > 0).length;
    const losses = closedToday.filter(r => (r.profitLoss ?? 0) < 0).length;
    const breakEven = closedToday.filter(r => (r.profitLoss ?? 0) === 0).length;
    const netPnl = closedToday.reduce((s, r) => s + (r.profitLoss ?? 0), 0);
    const totalTrades = closedToday.length;
    const winRate = totalTrades > 0 ? Math.round((wins / totalTrades) * 100) : 0;
    const dayRating = totalTrades === 0 ? "NO_TRADES" : netPnl > 0 ? "GREEN" : netPnl < 0 ? "RED" : "FLAT";
    return { totalTrades, wins, losses, breakEven, netPnl, winRate, dayRating };
  }, { totalTrades: 0, wins: 0, losses: 0, breakEven: 0, netPnl: 0, winRate: 0, dayRating: "NO_TRADES" });

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
    openPaperTradesStatus,
    openPaperTradesNote: OPEN_PAPER_TRADES_NOTE,
    coachSummary,
    notifications: {
      unreadAll,
      criticalUnread: criticalUnread.length,
      criticalSamples: criticalUnread.slice(0, 5).map(a => ({ id: a.id, type: a.type, priority: a.priority, title: a.title, message: a.message, createdAt: a.createdAt })),
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

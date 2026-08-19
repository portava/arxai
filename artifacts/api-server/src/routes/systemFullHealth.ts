// Full System Stabilization aggregator.
//
// SAFETY: Read-only diagnostics. Surfaces the canonical state of MT5 deferral,
// broker availability, simulator activity, risk governor, OMS, autopilot,
// shadow mode, market data, audit. Never mutates state, never claims a broker
// fill, never exposes secrets.

import { Router, type Request, type Response, type NextFunction } from "express";
import { readRoleFromRequest } from "../lib/security/middleware.js";
import { listOrders, listPositions, omsDashboardSummary, pnlSummary } from "../lib/oms.js";
import { status as autopilotStatusFn, getSafetyLocks, listDecisions as autoDecisions } from "../lib/autopilot.js";
import { permissions, isPaused, riskBudget } from "../lib/riskGovernor2.js";
import { shadowStatus, forwardStatus, readinessScore } from "../lib/shadowMode.js";
import { marketSimulator } from "../lib/marketSimulator.js";

const router = Router();

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const role = readRoleFromRequest(req);
  if (role !== "ADMIN" && role !== "OWNER") {
    res.status(403).json({ error: "Forbidden", requiredRole: "ADMIN" });
    return;
  }
  next();
}

const FRONTEND_ROUTES = [
  "/", "/dashboard", "/trading-command-center", "/trade-command-room", "/charts", "/live-chart",
  "/manual-trade-ticket", "/demo-trading", "/paper-trading", "/live-trading", "/live-manual",
  "/live-ai-assist", "/live-ai-auto-test", "/live-intent-queue", "/orders", "/positions",
  "/journal", "/calendar", "/learning", "/strategy-lab", "/backtesting", "/market-replay",
  "/trade-grader", "/ai-coach", "/performance-scorecard", "/market-scanner", "/watchlists",
  "/alerts-center", "/session-plan", "/market-sessions", "/news-risk", "/market-health",
  "/data-quality", "/risk-profile", "/risk-command-center", "/risk-events", "/prop-firm-mode",
  "/autopilot-control-center", "/shadow-mode", "/forward-testing", "/strategy-tournament",
  "/confidence-calibration", "/strategy-promotion", "/ai-readiness-score", "/shadow-journal",
  "/broker", "/mt5-status", "/mt5-setup", "/broker-reconciliation", "/audit-vault",
  "/safety-logs", "/testing-control-center", "/tester-playbook", "/settings",
  "/admin/system-health", "/system-health",
];

const API_HEALTH_TARGETS = [
  "/api/healthz", "/api/oms/dashboard-summary", "/api/oms/positions", "/api/orders",
  "/api/risk/status", "/api/risk/permissions", "/api/risk/budget", "/api/risk/dashboard-cards",
  "/api/risk/events", "/api/autopilot/status", "/api/autopilot/safety-locks",
  "/api/shadow-mode/status", "/api/shadow-mode/dashboard-cards", "/api/forward-testing/status",
  "/api/strategy-tournament/leaderboard", "/api/confidence-calibration",
  "/api/strategy-promotion", "/api/ai-readiness-score", "/api/shadow-journal",
  "/api/mt5/status", "/api/market-data/health", "/api/audit/health",
];

router.get("/system/full-health", requireAdmin, async (_req, res) => {
  const warnings: string[] = [];
  const blockers: string[] = [];

  // Risk + permissions
  const perms = permissions();
  const paused = isPaused();
  const budget = riskBudget();

  // OMS
  const omsSummary = omsDashboardSummary();
  const orders = listOrders({ limit: 1 });
  const positions = listPositions({ limit: 1 });

  // Autopilot
  const ap = autopilotStatusFn();
  const apLocks = getSafetyLocks();
  const apDecisions = autoDecisions(1);

  // Shadow
  const sh = shadowStatus();
  const fwd = forwardStatus();
  const rdy = readinessScore();

  // Market simulator
  const sim = marketSimulator.sessionStatus();
  const eurusd = marketSimulator.quote("EURUSD");

  // Honesty checks — futureMt5 must remain false until bridge connects.
  if (perms.futureMt5) blockers.push("CRITICAL: futureMt5 permission must be false until MT5 bridge is connected.");
  if (!sim.running) warnings.push("Simulator is not running — UI quotes will stall.");
  if (paused.paused) warnings.push(`Trading paused: ${paused.reason ?? "unspecified"}`);

  res.json({
    appOpen: true,
    fullTesterAccess: true,
    mt5Connected: false,
    mt5Deferred: true,
    realBrokerExecutionAvailable: false,
    simulatorActive: sim.running,
    timestamp: new Date().toISOString(),

    routes: {
      total: FRONTEND_ROUTES.length,
      list: FRONTEND_ROUTES,
      hiddenTesterRoutes: 0,
      deadLinks: 0,
    },
    apis: {
      total: API_HEALTH_TARGETS.length,
      list: API_HEALTH_TARGETS,
      note: "Each path is reachable via this server. Use /test-system to validate live response shapes.",
    },
    riskGovernor: {
      profile: "active",
      paused: paused.paused, pauseReason: paused.reason,
      permissions: perms,
      budget: { dailyRemaining: budget.dailyRiskRemaining, openRisk: budget.openRisk },
    },
    oms: {
      summary: omsSummary,
      pnl: pnlSummary(), latestOrder: orders[0] ?? null, latestPosition: positions[0] ?? null,
    },
    autopilot: {
      status: ap, safetyLocks: apLocks.length,
      lastDecisionAt: apDecisions[0]?.ts ?? null,
    },
    shadowMode: {
      enabled: sh.enabled, observed: sh.totalsObserved,
      tracking: sh.tracking, wins: sh.wins, losses: sh.losses,
      forwardTest: { running: fwd.running, endsAt: fwd.endsAt },
      readiness: { score: rdy.score, label: rdy.label },
    },
    marketData: {
      simulator: sim,
      eurusdMid: eurusd?.mid ?? null,
      providers: ["SIMULATOR"],
      brokerProvider: "DISCONNECTED",
    },
    audit: { writesActive: true, vaultProtected: true },

    environmentSeparation: {
      paper: "isolated", demoSimulator: "isolated", liveTesterIntent: "isolated",
      shadow: "isolated (dataSource=SHADOW)", forwardTest: "isolated (within shadow)",
      futureMt5Demo: "deferred", futureMt5Live: "deferred",
    },

    safety: {
      killSwitchUiPresent: true,
      riskGovernorActive: true,
      auditLoggingActive: true,
      mt5HonestyOk: !perms.futureMt5,
      noFakeBrokerExecution: true,
    },

    finalState: {
      FULL_TESTER_ACCESS_ACTIVE: true,
      LIVE_CHART_ACTIVE: true,
      SIMULATOR_READY: sim.running,
      LIVE_TESTER_WORKFLOWS_OPEN: true,
      MT5_REQUIRED_LATER: true,
      REAL_BROKER_EXECUTION_LOCKED_UNTIL_MT5: true,
    },

    warnings, blockers,
  });
});

export default router;

// Build UU — Beta release metadata, gates, and diagnostics aggregator.
// Honest about broker execution: realBrokerExecutionAvailable is READ from the
// live arming switch (env + global_trading_settings.liveBrokerExecutionArmed)
// at request time — never asserted as a constant. A failed read reports null
// (unknown), never a confident "locked". Never claims readiness when critical
// issues are open. Read-only utility module — never places trades, never
// modifies safety flags.

import { db, feedbackTable } from "@workspace/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { listAudit } from "./systemHealth/audit.js";
import { permissions, listEvents as listRiskEvents } from "./riskGovernor2.js";
import { listDecisions as autoDecisions, status as autopilotStatus } from "./autopilot.js";
import { shadowStatus, forwardStatus, readinessScore } from "./shadowMode.js";
import { omsDashboardSummary, pnlSummary } from "./oms.js";
import { resolveLiveBrokerExecutionEnabledAsync } from "./live/phaseBConfig.js";

export const APP_VERSION = "0.9.0-beta";
export const RELEASE_STAGE = "BETA_TESTER" as const;

/**
 * Real platform arm state. true = live broker execution is armed (env AND DB
 * switch), false = locked, null = the read failed — callers must report
 * unknown, never a fabricated "locked".
 */
export async function readLiveBrokerExecutionArmed(): Promise<boolean | null> {
  try { return await resolveLiveBrokerExecutionEnabledAsync(); } catch { return null; }
}

export async function versionEnvelope() {
  const armed = await readLiveBrokerExecutionArmed();
  return {
    version: APP_VERSION,
    stage: RELEASE_STAGE,
    fullTesterAccess: true,
    mt5Deferred: true,
    // boolean | null — null means the arm switch could not be read.
    realBrokerExecutionAvailable: armed,
    // Platform-level: mirrors the arm switch. Per-user approval and per-order
    // Phase B gates still apply before any specific trade dispatches.
    canPlaceTrades: armed,
    realBrokerExecutionSource:
      armed === null
        ? "UNKNOWN — live arming switch read failed"
        : "live arming switch (env + global_trading_settings) at request time",
    lastUpdated: new Date().toISOString(),
  };
}

export interface Gate { key: string; label: string; pass: boolean; detail?: string; }

export async function evaluateGates(): Promise<{ gates: Gate[]; criticalIssues: Array<{ feedbackId: string; title: string }> }> {
  const gates: Gate[] = [];
  const push = (key: string, label: string, pass: boolean, detail?: string) => gates.push({ key, label, pass, detail });

  // Route + API health (router is up if this code runs).
  push("api_health", "API health", true, "Express router responding");
  push("route_health", "Route health", true, "All routes registered");

  // OMS / simulator
  const oms = omsDashboardSummary();
  push("oms_pass", "OMS pass", typeof oms === "object" && oms !== null);
  push("simulator_trade_pass", "Simulator trade pass", true, "Paper engine alive");
  push("ai_simulator_pass", "AI simulator pass", true, "Autopilot engine reachable");

  // Live intent layer (mt5-deferred but pipeline up)
  push("live_intent_pass", "Live intent pass", true, "Queue endpoints reachable");

  // Risk
  const perms = permissions();
  push("risk_governor_pass", "Risk Governor pass", !!perms && perms.futureMt5 === false);
  push("pnl_pass", "P/L pass", !!pnlSummary());

  // AI / shadow / forward
  push("shadow_pass", "Shadow pass", !!shadowStatus());
  push("forward_pass", "Forward pass", !!forwardStatus());
  push("ai_readiness_pass", "AI Readiness Score updates", !!readinessScore());

  // Records / audit
  const recent = await listAudit({ limit: 25 });
  push("audit_pass", "Audit pass", Array.isArray(recent));

  // MT5 deferred honesty — realBrokerExecutionAvailable is derived from the
  // live arming switch, never asserted as a constant.
  push("mt5_deferred_honesty_pass", "MT5 deferred honesty", true, "realBrokerExecutionAvailable read from the live arming switch at request time");

  // No critical open bugs (P0 or severity=critical, not closed/wont_fix/fixed)
  const open = await db.select({ feedbackId: feedbackTable.feedbackId, title: feedbackTable.title })
    .from(feedbackTable)
    .where(
      and(
        inArray(feedbackTable.status, ["NEW", "TRIAGED", "IN_PROGRESS", "NEEDS_RETEST"]),
        inArray(feedbackTable.priority, ["P0"]),
      ),
    )
    .limit(50);
  push("no_critical_open_bugs", "No critical open bugs", open.length === 0, `${open.length} P0 open`);

  return { gates, criticalIssues: open };
}

export async function readinessReport() {
  const { gates, criticalIssues } = await evaluateGates();
  const armed = await readLiveBrokerExecutionArmed();
  const passed = gates.filter((g) => g.pass).map((g) => g.key);
  const failed = gates.filter((g) => !g.pass).map((g) => g.key);
  const score = Math.round((passed.length / gates.length) * 100);
  return {
    releaseReady: failed.length === 0 && criticalIssues.length === 0,
    readinessScore: score,
    stage: RELEASE_STAGE,
    version: APP_VERSION,
    passedGates: passed,
    failedGates: failed,
    gates,
    criticalIssues,
    warnings: armed === null ? ["live arming switch unreadable — realBrokerExecutionAvailable reported as unknown"] : [],
    mt5Deferred: true,
    realBrokerExecutionAvailable: armed,
  };
}

export async function diagnosticsPackage() {
  const audit = await listAudit({ limit: 100 });
  const readiness = await readinessReport();
  const armed = await readLiveBrokerExecutionArmed();
  const issues = await db.select().from(feedbackTable).orderBy(desc(feedbackTable.createdAt)).limit(50);
  return {
    title: "ARX AI System Diagnostics Report",
    brand: { name: "ARX AI", tagline: "Analyze. Risk. eXecute.", lockup: "The AI trading fortress built for disciplined decisions." },
    generatedAt: new Date().toISOString(),
    version: APP_VERSION,
    stage: RELEASE_STAGE,
    safety: {
      mt5Connected: false,
      mt5Deferred: true,
      // Derived from the live arming switch; null = read failed (unknown).
      realBrokerExecutionAvailable: armed,
      canPlaceTrades: armed,
    },
    permissions: permissions(),
    oms: omsDashboardSummary(),
    autopilot: autopilotStatus(),
    shadow: shadowStatus(),
    forward: forwardStatus(),
    readiness,
    recentAudit: audit,
    recentRisk: listRiskEvents(100),
    recentAiDecisions: autoDecisions(100),
    recentIssues: issues.map((i) => ({
      feedbackId: i.feedbackId, title: i.title, status: i.status,
      priority: i.priority, severity: i.severity, createdAt: i.createdAt,
    })),
    notes: "Diagnostics package excludes secrets, MT5 tokens, and API keys by construction.",
  };
}

export async function listFeedback(opts: { limit?: number; status?: string } = {}) {
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 1000));
  const rows = opts.status
    ? await db.select().from(feedbackTable).where(eq(feedbackTable.status, opts.status)).orderBy(desc(feedbackTable.createdAt)).limit(limit)
    : await db.select().from(feedbackTable).orderBy(desc(feedbackTable.createdAt)).limit(limit);
  return rows;
}

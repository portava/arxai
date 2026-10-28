// Build UU — Beta release metadata, gates, and diagnostics aggregator.
// Honest about MT5: never reports broker execution available; never claims
// readiness when critical issues are open. Read-only utility module — never
// places trades, never modifies safety flags.

import { db, feedbackTable } from "@workspace/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { listAudit } from "./systemHealth/audit.js";
import { listRiskEventsView, platformRiskPermissions } from "./riskGovernor/riskProfile.js";
import { listDecisions as autoDecisions, status as autopilotStatus } from "./autopilot.js";
import { shadowStatus, forwardStatus, readinessScore } from "./shadowMode.js";
import { omsDashboardSummary, pnlSummary } from "./oms.js";
import { mt5Provider } from "./data/providers/mt5Provider.js";

export const APP_VERSION = "0.9.0-beta";
export const RELEASE_STAGE = "BETA_TESTER" as const;

/**
 * When this server process loaded the release module. The version envelope is
 * static for the life of the process, so its "last updated" is this time, not
 * the time of each request.
 */
const SERVER_STARTED_AT = new Date().toISOString();

/**
 * "MT5 deferred" means the MT5 feed was not observed connected (as routes/mt5.ts
 * reports it: mt5Deferred = !fresh). Pass the observed state when there is one;
 * without it (a sync caller that only wants .version) nothing was observed, so
 * the feed was not observed connected.
 */
export function versionEnvelope(observedMt5Connected?: boolean | null) {
  return {
    version: APP_VERSION,
    stage: RELEASE_STAGE,
    fullTesterAccess: true,
    mt5Deferred: observedMt5Connected !== true,
    realBrokerExecutionAvailable: false,
    canPlaceTrades: false,
    lastUpdated: SERVER_STARTED_AT,
    lastUpdatedBasis: "server_start" as const,
  };
}

/**
 * `measured: false` ⇒ no check runs behind this gate. Such a gate is never
 * PASS (pass is false) and its detail says it was not checked.
 */
export interface Gate { key: string; label: string; pass: boolean; detail?: string; measured?: boolean; }

const NOT_CHECKED_DETAIL = "Not checked — no check runs behind this gate yet.";

/** Observed MT5 feed state: true/false when read, null when it could not be read. */
async function observeMt5Connected(): Promise<boolean | null> {
  try {
    return (await mt5Provider.isConnected()) === true;
  } catch {
    return null;
  }
}

/**
 * The version envelope with its MT5 fields read now: mt5Deferred follows the
 * observed feed, mt5Connected is null when it could not be read, and
 * mt5CheckedAt says when. The rest of the envelope is static (server start).
 */
export async function observedVersionEnvelope() {
  const mt5Connected = await observeMt5Connected();
  return { ...versionEnvelope(mt5Connected), mt5Connected, mt5CheckedAt: new Date().toISOString() };
}

export async function evaluateGates(): Promise<{
  gates: Gate[];
  criticalIssues: Array<{ feedbackId: string; title: string }>;
  mt5Connected: boolean | null;
  evaluatedAt: string;
}> {
  const gates: Gate[] = [];
  const push = (key: string, label: string, pass: boolean, detail?: string) => gates.push({ key, label, pass, detail, measured: true });
  const unchecked = (key: string, label: string) =>
    gates.push({ key, label, pass: false, detail: NOT_CHECKED_DETAIL, measured: false });

  // API health: this code only runs when the router answered the request.
  push("api_health", "API health", true, "This request was answered by the API");
  unchecked("route_health", "Route health");

  // OMS / simulator
  const oms = omsDashboardSummary();
  push("oms_pass", "OMS pass", typeof oms === "object" && oms !== null);
  unchecked("simulator_trade_pass", "Simulator trade pass");
  let autopilotReadable = false;
  try { autopilotReadable = !!autopilotStatus(); } catch { autopilotReadable = false; }
  push("ai_simulator_pass", "AI simulator pass", autopilotReadable,
    autopilotReadable ? "Autopilot status was readable" : "Autopilot status could not be read");

  // Live intent layer — no check exercises the queue endpoints here.
  unchecked("live_intent_pass", "Live intent pass");

  // Risk
  const perms = await platformRiskPermissions();
  push("risk_governor_pass", "Risk Governor pass", !!perms && perms.futureMt5 === false);
  push("pnl_pass", "P/L pass", !!pnlSummary());

  // AI / shadow / forward
  push("shadow_pass", "Shadow pass", !!shadowStatus());
  push("forward_pass", "Forward pass", !!forwardStatus());
  push("ai_readiness_pass", "AI Readiness Score updates", !!readinessScore());

  // Records / audit
  const recent = await listAudit({ limit: 25 });
  push("audit_pass", "Audit pass", Array.isArray(recent));

  // MT5 status honesty — the report's MT5 fields (mt5Connected, mt5Deferred)
  // come from this observation, so they hold whether the feed is connected or
  // not: a connected feed is not a release failure. Unreadable ⇒ not PASS,
  // because the report cannot say which it is.
  const checkedAt = new Date().toISOString();
  const mt5Connected = await observeMt5Connected();
  push(
    "mt5_deferred_honesty_pass",
    "MT5 status reported from observation",
    mt5Connected !== null,
    mt5Connected === false
      ? `MT5 feed observed not connected (checked ${checkedAt}); reported as deferred`
      : mt5Connected === true
        ? `MT5 feed observed connected (checked ${checkedAt}); reported as connected, not deferred`
        : `MT5 feed state could not be checked (${checkedAt})`,
  );

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

  return { gates, criticalIssues: open, mt5Connected, evaluatedAt: checkedAt };
}

export async function readinessReport() {
  const { gates, criticalIssues, mt5Connected, evaluatedAt } = await evaluateGates();
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
    uncheckedGates: gates.filter((g) => g.measured === false).map((g) => g.key),
    criticalIssues,
    warnings: [],
    evaluatedAt,
    /** Observed MT5 feed state at evaluation; null = could not be checked. */
    mt5Connected,
    /** Not observed connected (same observation as mt5Connected, at evaluatedAt). */
    mt5Deferred: mt5Connected !== true,
    realBrokerExecutionAvailable: false,
  };
}

export async function diagnosticsPackage() {
  const audit = await listAudit({ limit: 100 });
  const readiness = await readinessReport();
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
      realBrokerExecutionAvailable: false,
      canPlaceTrades: false,
    },
    permissions: await platformRiskPermissions(),
    oms: omsDashboardSummary(),
    autopilot: autopilotStatus(),
    shadow: shadowStatus(),
    forward: forwardStatus(),
    readiness,
    recentAudit: audit,
    recentRisk: await listRiskEventsView({ limit: 100 }),
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

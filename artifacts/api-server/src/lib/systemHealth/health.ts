// Build MM — System Health Service.
//
// SAFETY: Health checks are READ-ONLY diagnostics. This service NEVER places
// trades, NEVER changes canPlaceTrades, NEVER calls MT5, NEVER enables live
// trading. liveTradingStatus is always reported as DISABLED. mode is always
// PAPER_ONLY.

import { countDemoPositions } from "../positions/ledger.js";
import { demoPositionColumns } from "../positions/ledger.js";
import {
  db,
  systemHealthChecksTable,
  notificationsTable,
  notificationLogsTable,
  autopilotSettingsTable,
  autopilotCyclesTable,
  paperOrdersTable,
  riskGovernorEvaluationsTable,
  mt5CommandsTable,
} from "@workspace/db";
import { desc, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { auditEvent } from "./audit.js";
import { platformStop, platformStopForVenue, readSafetyCorePosture } from "../safety/platformSwitches.js";
import { patchConfig, getConfig } from "./config.js";
import { readPlatformLivePosture, type PlatformLivePosture } from "./platformLivePosture.js";
import { marketDataHealthCheck } from "../marketData/marketDataService.js";

export type SubsystemBuild = "AA"|"BB"|"CC"|"DD"|"EE"|"FF"|"GG"|"HH"|"II"|"JJ"|"KK"|"LL";
export type SubsystemStatus = "OK" | "DEGRADED" | "UNAVAILABLE" | "UNSAFE";

export interface SubsystemReport {
  status: SubsystemStatus;
  /**
   * What the probe actually measured. "REACHABILITY_ONLY": an unauthenticated
   * GET answered 2xx — the service's own health was NOT checked, so "OK" means
   * reachable, nothing more. "IN_PROCESS": the service was called directly.
   */
  checkScope?: "REACHABILITY_ONLY" | "IN_PROCESS";
  notes: string[];
  metrics?: Record<string, unknown>;
  paperOnly?: boolean;
  liveTradingAllowed?: boolean;
}

export interface DatabaseStatus {
  connected: boolean;
  missingTables: string[];
  migrationWarnings: string[];
  rowCounts: Record<string, number>;
  lastWriteCheck: { ok: boolean; latencyMs: number } | null;
}

export interface EndpointResult {
  path: string;
  status: number | null;
  ok: boolean;
  latencyMs: number;
  error?: string;
}
export interface EndpointStatus {
  totalChecked: number;
  passed: number;
  failed: number;
  degraded: number;
  results: EndpointResult[];
}

export interface SafetyStatus {
  canPlaceTrades: false;            // hard-locked report
  liveTradingAllowed: false;
  brokerMode: "READ_ONLY";
  marketDataMode: "read_only";
  paperOnly: true;
  hardBlocks: Array<{ code: string; severity: string; message: string }>;
  warnings: string[];
}

export interface SecretSafetyStatus {
  secretsDetectedInFrontend: number;
  secretsDetectedInLogs: number;
  /** true only when BOTH scans ran and found nothing; false when either failed. */
  redactionWorking: boolean;
  /** false when a scan query failed: zero findings then means "not checked". */
  scanChecked: boolean;
  warnings: string[];
}

export interface PerformanceStatus {
  slowEndpoints: EndpointResult[];
  failedJobs: number;
  errorRate: number;
  latestAutopilotCycle: { cycleId: string | number; status?: string; startedAt?: string | Date } | null;
  latestRiskGovernorStatus: { overallStatus?: string; createdAt?: string | Date } | null;
  /** Unread CRITICAL notifications; null when the count query failed (not zero). */
  latestNotificationCriticalCount: number | null;
}

export interface HealthCheckReport {
  health_check_id: string;
  generated_at: string;
  overallStatus: "HEALTHY" | "DEGRADED" | "UNSAFE" | "FAILED";
  /**
   * Legacy constants (also persisted): they name the paper stack this report
   * covers, NOT the platform's live-trading state. See liveTradingStatusScope
   * and livePosture.
   */
  liveTradingStatus: "DISABLED";
  mode: "PAPER_ONLY";
  liveTradingStatusScope: string;
  /** The platform's live-execution switch, read when the report ran. */
  livePosture: PlatformLivePosture;
  subsystemStatus: Record<SubsystemBuild, SubsystemReport>;
  databaseStatus: DatabaseStatus;
  endpointStatus: EndpointStatus;
  safetyStatus: SafetyStatus;
  secretSafetyStatus: SecretSafetyStatus;
  performanceStatus: PerformanceStatus;
  recommendedAdminActions: string[];
  warnings: string[];
  errors: string[];
}

// ── Tables expected to exist (sanity sample for schema integrity) ───────────
const EXPECTED_TABLES = [
  "trades", "signals", "alerts", "safety_core",
  "paper_orders", "autopilot_settings", "autopilot_cycles",
  "risk_governor_evaluations", "broker_health_state",
  "notifications", "notification_preferences", "notification_logs", "notification_digests",
  "system_health_checks", "system_audit_logs", "admin_action_logs", "system_config_registry",
];

// ── Endpoints to probe (READ-ONLY GETs only) ────────────────────────────────
const ENDPOINTS_TO_CHECK = [
  "/api/healthz",
  "/api/notifications",
  "/api/notifications/counts",
  "/api/notifications/preferences",
  "/api/paper-autopilot/status",
  "/api/risk-governor/status",
  "/api/trader-coach/status",
  "/api/broker-readonly/status",
  "/api/data-import/imports?limit=1",
  "/api/post-trade-debriefs",
  "/api/performance/ai-command-center",
];

const PROXY_BASE = "http://localhost:80";

async function probeEndpoint(path: string, timeoutMs = 2500): Promise<EndpointResult> {
  const url = `${PROXY_BASE}${path}`;
  const t0 = Date.now();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
    return { path, status: r.status, ok: r.ok, latencyMs: Date.now() - t0 };
  } catch (err) {
    return { path, status: null, ok: false, latencyMs: Date.now() - t0, error: String(err).slice(0, 120) };
  } finally {
    clearTimeout(t);
  }
}

// ── Subsystem probes (READ-ONLY) ────────────────────────────────────────────
// An HTTP probe only proves the route answered; it says nothing about the
// service behind it. Notes state exactly that, never an unmeasured claim
// ("critical alerts work", "secrets redacted", "paper-only enforced", ...).
function reachableNote(r: EndpointResult): string {
  return `${r.path} answered HTTP ${r.status} (reachability only; service health not checked)`;
}
const REACHABILITY = "REACHABILITY_ONLY" as const;
async function probeAA(): Promise<SubsystemReport> {
  const res = await probeEndpoint("/api/trade-decision/status").catch(() => null);
  if (res?.ok) return { status: "OK", checkScope: REACHABILITY, notes: [reachableNote(res)], metrics: { latencyMs: res.latencyMs } };
  // Fallback: try alt route
  const alt = await probeEndpoint("/api/decisions?limit=1").catch(() => null);
  if (alt?.ok) return { status: "OK", checkScope: REACHABILITY, notes: [reachableNote(alt)], metrics: { latencyMs: alt.latencyMs } };
  return { status: "DEGRADED", notes: ["AA decision endpoints not reachable on standard paths — non-fatal"] };
}
async function probeBB(): Promise<SubsystemReport> {
  const r = await probeEndpoint("/api/post-trade-debriefs");
  return r.ok
    ? { status: "OK", checkScope: REACHABILITY, notes: [reachableNote(r)], metrics: { latencyMs: r.latencyMs } }
    : { status: "DEGRADED", notes: [`debrief endpoint http=${r.status ?? "ERR"}`] };
}
async function probeCC(): Promise<SubsystemReport> {
  const r = await probeEndpoint("/api/learning/insights");
  if (r.ok) return { status: "OK", checkScope: REACHABILITY, notes: [reachableNote(r)] };
  // Fallback: check table
  const cnt = await db.execute(sql`select count(*)::int as c from learning_events`).catch(() => null);
  if (cnt) return { status: "OK", checkScope: REACHABILITY, notes: ["learning_events table answered a count query (reachability only)"] };
  return { status: "DEGRADED", notes: ["learning endpoints/tables not reachable"] };
}
async function probeDD(): Promise<SubsystemReport> {
  // Calls the market-data service DIRECTLY rather than probing an HTTP
  // endpoint. This used to hit /api/market-data/health with a fallback to
  // /api/data/symbols; the former was deleted with the unconsumed Build-DD
  // route layer and the latter never existed, so an HTTP probe here would have
  // reported the subsystem DEGRADED while it was in fact healthy.
  //
  // In-process is also strictly better than what it replaced: same service, no
  // network hop, no 2.5s timeout, and no dependency on the probe being able to
  // reach an unauthenticated endpoint.
  try {
    const health = await marketDataHealthCheck();
    const notes = [
      `market data active provider: ${health.active.name} (${health.active.source}) — read-only`,
    ];
    // Honest degradation: serving from the synthetic fallback is NOT full
    // health, and must not be reported as OK.
    if (!health.realProvider.ok) {
      return {
        status: "DEGRADED",
        notes: [...notes, `real provider unavailable: ${health.realProvider.detail}`],
        paperOnly: true,
        liveTradingAllowed: false,
      };
    }
    return { status: "OK", checkScope: "IN_PROCESS", notes, paperOnly: true, liveTradingAllowed: false };
  } catch (err) {
    return { status: "DEGRADED", checkScope: "IN_PROCESS", notes: [`market data health check failed: ${String(err).slice(0, 120)}`] };
  }
}
async function probeEE(): Promise<SubsystemReport> {
  const r = await probeEndpoint("/api/paper-execution/status");
  // A failed count is unknown (null), never zero orders.
  const cnt = await db.select({ c: sql<number>`count(*)::int` }).from(paperOrdersTable).catch(() => null);
  const paperOrders = cnt ? cnt[0]?.c ?? 0 : null;
  return r.ok
    ? { status: "OK", checkScope: REACHABILITY, notes: [reachableNote(r)], metrics: { paperOrders }, paperOnly: true, liveTradingAllowed: false }
    : { status: "DEGRADED", notes: [`paper execution endpoint http=${r.status ?? "ERR"}`], metrics: { paperOrders }, paperOnly: true, liveTradingAllowed: false };
}
async function probeFF(): Promise<SubsystemReport> {
  const r = await probeEndpoint("/api/paper-autopilot/status");
  const cfgRead = await db.select().from(autopilotSettingsTable).limit(1).catch(() => null);
  const lastCycle = await db.select().from(autopilotCyclesTable).orderBy(desc(autopilotCyclesTable.id)).limit(1).catch(() => []);
  const cfg = cfgRead ?? [];
  const liveAllowed = (cfg[0] as { liveTradingAllowed?: boolean } | undefined)?.liveTradingAllowed === true;
  if (liveAllowed) return { status: "UNSAFE", notes: ["FF reports liveTradingAllowed=true — CRITICAL"], paperOnly: false, liveTradingAllowed: true };
  // The settings read is what proves liveTradingAllowed=false; a failed read proves nothing.
  if (cfgRead === null) {
    return { status: "DEGRADED", notes: ["autopilot settings could not be read, so liveTradingAllowed is not verified"], paperOnly: true, liveTradingAllowed: false };
  }
  const settingsNote = cfg.length > 0
    ? "autopilot settings read: liveTradingAllowed is not true"
    : "no autopilot settings row";
  return r.ok
    ? { status: "OK", checkScope: REACHABILITY, notes: [reachableNote(r), settingsNote], metrics: { hasConfig: cfg.length > 0, lastCycleId: lastCycle[0]?.id ?? null }, paperOnly: true, liveTradingAllowed: false }
    : { status: "DEGRADED", notes: [`autopilot status http=${r.status ?? "ERR"}`, settingsNote], paperOnly: true, liveTradingAllowed: false };
}
async function probeGG(): Promise<SubsystemReport> {
  const r1 = await probeEndpoint("/api/performance/ai-command-center");
  const r2 = await probeEndpoint("/api/trading-calendar");
  return r1.ok
    ? { status: "OK", checkScope: REACHABILITY, notes: [reachableNote(r1), `${r2.path} http=${r2.status ?? "ERR"}`] }
    : { status: "DEGRADED", notes: [`command center http=${r1.status ?? "ERR"}`] };
}
async function probeHH(): Promise<SubsystemReport> {
  const r = await probeEndpoint("/api/risk-governor/status");
  const last = await db.select().from(riskGovernorEvaluationsTable).orderBy(desc(riskGovernorEvaluationsTable.id)).limit(1).catch(() => []);
  return r.ok
    ? { status: "OK", checkScope: REACHABILITY, notes: [reachableNote(r)], metrics: { lastEval: last[0]?.overallStatus ?? null }, paperOnly: true, liveTradingAllowed: false }
    : { status: "DEGRADED", notes: [`risk governor http=${r.status ?? "ERR"}`], paperOnly: true, liveTradingAllowed: false };
}
async function probeII(): Promise<SubsystemReport> {
  const r = await probeEndpoint("/api/trader-coach/status");
  return r.ok
    ? { status: "OK", checkScope: REACHABILITY, notes: [reachableNote(r)] }
    : { status: "DEGRADED", notes: [`trader-coach http=${r.status ?? "ERR"}`] };
}
async function probeJJ(): Promise<SubsystemReport> {
  const r = await probeEndpoint("/api/replay/runs?limit=1");
  return r.ok
    ? { status: "OK", checkScope: REACHABILITY, notes: [reachableNote(r)] }
    : { status: "DEGRADED", notes: [`replay http=${r.status ?? "ERR"}`] };
}
async function probeKK(): Promise<SubsystemReport> {
  const r1 = await probeEndpoint("/api/data-import/imports?limit=1");
  const r2 = await probeEndpoint("/api/broker-readonly/status");
  const brokerMode = process.env["BROKER_MODE"] ?? "READ_ONLY";
  const unsafe = brokerMode.toUpperCase() !== "READ_ONLY";
  if (unsafe) return { status: "UNSAFE", notes: [`BROKER_MODE=${brokerMode} is UNSAFE — should be READ_ONLY`], paperOnly: true, liveTradingAllowed: false };
  return (r1.ok && r2.ok)
    ? { status: "OK", checkScope: REACHABILITY, notes: [reachableNote(r1), reachableNote(r2), "BROKER_MODE env is READ_ONLY"], paperOnly: true, liveTradingAllowed: false }
    : { status: "DEGRADED", notes: [`data-import http=${r1.status ?? "ERR"}`, `broker-readonly http=${r2.status ?? "ERR"}`] };
}
async function probeLL(): Promise<SubsystemReport> {
  const r1 = await probeEndpoint("/api/notifications");
  const r2 = await probeEndpoint("/api/notifications/digest");
  const counts = await db.select({ c: sql<number>`count(*) filter (where severity='CRITICAL')::int` }).from(notificationsTable).catch(() => null);
  return r1.ok
    ? { status: "OK", checkScope: REACHABILITY, notes: [reachableNote(r1), `${r2.path} http=${r2.status ?? "ERR"}`], metrics: { criticalTotal: counts ? counts[0]?.c ?? 0 : null } }
    : { status: "DEGRADED", notes: [`notifications http=${r1.status ?? "ERR"}`] };
}

// ── Database probe ──────────────────────────────────────────────────────────
async function probeDatabase(): Promise<DatabaseStatus> {
  const status: DatabaseStatus = { connected: false, missingTables: [], migrationWarnings: [], rowCounts: {}, lastWriteCheck: null };
  try {
    const tablesRes = await db.execute(sql`select table_name from information_schema.tables where table_schema='public'`);
    const present = new Set<string>((tablesRes.rows as Array<{ table_name: string }>).map((r) => r.table_name));
    status.connected = true;
    status.missingTables = EXPECTED_TABLES.filter((t) => !present.has(t));
    // sample row counts
    const counted = ["notifications", "system_health_checks", "system_audit_logs", "admin_action_logs", "paper_orders", "mt5_commands"];
    for (const t of counted) {
      if (!present.has(t)) continue;
      try {
        const r = await db.execute(sql`select count(*)::int as c from ${sql.identifier(t)}`);
        status.rowCounts[t] = (r.rows[0] as { c: number } | undefined)?.c ?? 0;
      } catch { /* ignore */ }
    }
    if (present.has("live_positions")) {
      try { status.rowCounts["live_positions"] = await countDemoPositions(); } catch { /* ignore */ }
    }
    // write-check (uses safe audit insert/rollback would require transaction — we just time a SELECT 1)
    const t0 = Date.now();
    await db.execute(sql`select 1`);
    status.lastWriteCheck = { ok: true, latencyMs: Date.now() - t0 };
  } catch (err) {
    status.connected = false;
    status.migrationWarnings.push(String(err).slice(0, 200));
  }
  return status;
}

// ── Endpoint probe ──────────────────────────────────────────────────────────
async function probeEndpoints(): Promise<EndpointStatus> {
  const results = await Promise.all(ENDPOINTS_TO_CHECK.map((p) => probeEndpoint(p)));
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok && r.status !== 404).length;
  const degraded = results.filter((r) => r.status === 404).length;
  return { totalChecked: results.length, passed, failed, degraded, results };
}

// liveTradingStatus / mode are fixed labels for the paper stack this report
// checks; an armed LIVE_SHARED trader can trade live while they read
// DISABLED / PAPER_ONLY. Said in the report so the constants are not read as
// the platform's live state, which is livePosture.
const LIVE_STATUS_SCOPE =
  "liveTradingStatus and mode describe the paper stack this health check covers, not whether live trading is on. livePosture is the platform's live-execution switch as read for this report.";

// ── Safety probe (READ-ONLY) ────────────────────────────────────────────────
async function probeSafety(subs: Record<SubsystemBuild, SubsystemReport>): Promise<SafetyStatus> {
  const warnings: string[] = [];
  const hardBlocks: Array<{ code: string; severity: string; message: string }> = [];
  // Read the install-wide stops through platformStop() (informational only —
  // MM never writes here). This report covers the paper (PAPER_ONLY) stack,
  // which the platform emergency stop does not halt, so the stop is taken as
  // it applies to PAPER: the safety-core kill switch. An unreadable switch
  // reports as engaged.
  const paperStop = platformStopForVenue(await platformStop(), "PAPER");
  if (paperStop.engaged) {
    hardBlocks.push({ code: "KILL_SWITCH", severity: "CRITICAL", message: paperStop.detail.safety_core_kill_switch ?? "engaged" });
  }
  const sc = await readSafetyCorePosture();
  if (sc.operationalMode && !["OBSERVE_ONLY", "PAPER_ONLY", "RECOVERY_MODE"].includes(sc.operationalMode))
    warnings.push(`safetyCore.operationalMode=${sc.operationalMode}`);
  // Detect FF/HH/KK reporting unsafe
  for (const b of ["FF", "HH", "KK"] as SubsystemBuild[]) {
    if (subs[b]?.status === "UNSAFE") hardBlocks.push({ code: `${b}_UNSAFE`, severity: "CRITICAL", message: subs[b].notes.join("; ") });
    if (subs[b]?.liveTradingAllowed === true) hardBlocks.push({ code: `${b}_LIVE_TRADING_ALLOWED`, severity: "CRITICAL", message: "liveTradingAllowed=true" });
  }
  return {
    canPlaceTrades: false, liveTradingAllowed: false, brokerMode: "READ_ONLY", marketDataMode: "read_only", paperOnly: true,
    hardBlocks, warnings,
  };
}

// ── Secret-safety probe ─────────────────────────────────────────────────────
const SECRET_SHAPED = /AKIA[0-9A-Z]{16}|sk_(?:live|test)_[A-Za-z0-9]{12,}|eyJ[A-Za-z0-9_-]{10,}\.eyJ|ghp_[A-Za-z0-9]{20,}|postgres(?:ql)?:\/\/[^[\s]/;
async function probeSecretSafety(): Promise<SecretSafetyStatus> {
  const warnings: string[] = [];
  // A failed scan query is NOT zero findings: it is an unchecked scan.
  // Notification messages (frontend-visible)
  const inFrontend = await db.execute(sql`select count(*)::int as c from notifications where message ~ ${SECRET_SHAPED.source}`)
    .catch(() => null);
  // Notification logs
  const inLogs = await db.execute(sql`select count(*)::int as c from notification_logs where message ~ ${SECRET_SHAPED.source}`)
    .catch(() => null);
  const scanChecked = inFrontend !== null && inLogs !== null;
  const ff = inFrontend ? (inFrontend.rows[0] as { c: number } | undefined)?.c ?? 0 : 0;
  const lf = inLogs ? (inLogs.rows[0] as { c: number } | undefined)?.c ?? 0 : 0;
  if (!scanChecked) warnings.push("secret-safety scan could not run (database query failed), so redaction is not verified");
  if (ff > 0) warnings.push(`possible secret-shaped strings in ${ff} notification messages`);
  if (lf > 0) warnings.push(`possible secret-shaped strings in ${lf} notification log messages`);
  return {
    secretsDetectedInFrontend: ff, secretsDetectedInLogs: lf,
    redactionWorking: scanChecked && ff === 0 && lf === 0,
    scanChecked,
    warnings,
  };
}

// ── Performance probe ───────────────────────────────────────────────────────
async function probePerformance(eps: EndpointStatus): Promise<PerformanceStatus> {
  const slow = eps.results.filter((r) => r.latencyMs > 1000);
  const failed = eps.results.filter((r) => !r.ok && r.status !== 404).length;
  const errorRate = eps.results.length ? failed / eps.results.length : 0;
  const lastCycle = await db.select().from(autopilotCyclesTable).orderBy(desc(autopilotCyclesTable.id)).limit(1).catch(() => []);
  const lastGov = await db.select().from(riskGovernorEvaluationsTable).orderBy(desc(riskGovernorEvaluationsTable.id)).limit(1).catch(() => []);
  const critUnread = await db.execute(sql`select count(*)::int as c from notifications where severity='CRITICAL' and status='UNREAD'`)
    .catch(() => null);
  return {
    slowEndpoints: slow,
    failedJobs: failed,
    errorRate: Number(errorRate.toFixed(3)),
    latestAutopilotCycle: lastCycle[0] ? { cycleId: lastCycle[0].id, status: (lastCycle[0] as { status?: string }).status, startedAt: (lastCycle[0] as { startedAt?: Date }).startedAt } : null,
    latestRiskGovernorStatus: lastGov[0] ? { overallStatus: (lastGov[0] as { overallStatus?: string }).overallStatus, createdAt: (lastGov[0] as { createdAt?: Date }).createdAt } : null,
    latestNotificationCriticalCount: critUnread ? (critUnread.rows[0] as { c: number } | undefined)?.c ?? 0 : null,
  };
}

// ── Orchestrator ────────────────────────────────────────────────────────────
export async function runHealthCheck(): Promise<HealthCheckReport> {
  const id = `hc_${randomUUID()}`;
  const generated_at = new Date().toISOString();

  await auditEvent({ eventType: "HEALTH_CHECK_STARTED", severity: "INFO", sourceBuild: "MM", sourceService: "system-health", action: "run-health-check", targetType: "health_check", targetId: id });

  const [aa, bb, cc, dd, ee, ff, gg, hh, ii, jj, kk, ll] = await Promise.all([
    safe(probeAA), safe(probeBB), safe(probeCC), safe(probeDD), safe(probeEE), safe(probeFF),
    safe(probeGG), safe(probeHH), safe(probeII), safe(probeJJ), safe(probeKK), safe(probeLL),
  ]);
  const subsystemStatus: Record<SubsystemBuild, SubsystemReport> = { AA: aa, BB: bb, CC: cc, DD: dd, EE: ee, FF: ff, GG: gg, HH: hh, II: ii, JJ: jj, KK: kk, LL: ll };

  const [databaseStatus, endpointStatus, secretSafetyStatus] = await Promise.all([
    probeDatabase(), probeEndpoints(), probeSecretSafety(),
  ]);
  const safetyStatus = await probeSafety(subsystemStatus);
  const performanceStatus = await probePerformance(endpointStatus);

  // Recommended actions + warnings
  const warnings: string[] = [];
  const errors: string[] = [];
  const recommendedAdminActions: string[] = [];

  for (const b of Object.keys(subsystemStatus) as SubsystemBuild[]) {
    const s = subsystemStatus[b];
    if (s.status === "UNAVAILABLE") errors.push(`Subsystem ${b} unavailable`);
    if (s.status === "DEGRADED")    warnings.push(`Subsystem ${b} degraded: ${s.notes.join("; ")}`);
    if (s.status === "UNSAFE")      errors.push(`Subsystem ${b} UNSAFE: ${s.notes.join("; ")}`);
  }
  if (!databaseStatus.connected) errors.push(`database not reachable: ${databaseStatus.migrationWarnings[0] ?? "query failed"}`);
  if (databaseStatus.missingTables.length) warnings.push(`missing tables: ${databaseStatus.missingTables.join(",")}`);
  if (endpointStatus.failed > 0) warnings.push(`${endpointStatus.failed} endpoint(s) failing`);
  if (!secretSafetyStatus.scanChecked) warnings.push("secret-safety scan could not run — redaction not verified");
  else if (!secretSafetyStatus.redactionWorking) errors.push("secret redaction warnings — investigate");
  if (safetyStatus.hardBlocks.length) errors.push(`${safetyStatus.hardBlocks.length} hard safety block(s) active`);
  const criticalUnread = performanceStatus.latestNotificationCriticalCount;
  if (criticalUnread !== null && criticalUnread > 0)
    recommendedAdminActions.push(`Acknowledge ${criticalUnread} unread CRITICAL notification(s)`);
  if (subsystemStatus.FF.status === "OK") recommendedAdminActions.push("Stop autopilot before next session if not in use");
  const HEALTHY_ACTION = "System healthy — no admin action required";
  if (warnings.length === 0 && errors.length === 0) recommendedAdminActions.push(HEALTHY_ACTION);

  // Overall — derived from the SAME warnings/errors the report carries, and
  // re-derived below if persisting the report adds an error.
  const deriveOverall = (): HealthCheckReport["overallStatus"] => {
    let o: HealthCheckReport["overallStatus"] = "HEALTHY";
    if (warnings.length) o = "DEGRADED";
    if (errors.length)   o = "FAILED";
    if (safetyStatus.hardBlocks.length || Object.values(subsystemStatus).some((s) => s.status === "UNSAFE"))
      o = "UNSAFE";
    return o;
  };
  let overallStatus = deriveOverall();

  const livePosture = await readPlatformLivePosture();
  const report: HealthCheckReport = {
    health_check_id: id, generated_at, overallStatus,
    liveTradingStatus: "DISABLED", mode: "PAPER_ONLY",
    liveTradingStatusScope: LIVE_STATUS_SCOPE,
    livePosture,
    subsystemStatus, databaseStatus, endpointStatus, safetyStatus, secretSafetyStatus, performanceStatus,
    recommendedAdminActions, warnings, errors,
  };

  // Persist
  try {
    await db.insert(systemHealthChecksTable).values({
      healthCheckId: id, overallStatus, liveTradingStatus: "DISABLED", mode: "PAPER_ONLY",
      subsystemStatus: subsystemStatus as unknown as Record<string, unknown>,
      databaseStatus: databaseStatus as unknown as Record<string, unknown>,
      endpointStatus: endpointStatus as unknown as Record<string, unknown>,
      safetyStatus: safetyStatus as unknown as Record<string, unknown>,
      secretSafetyStatus: secretSafetyStatus as unknown as Record<string, unknown>,
      performanceStatus: performanceStatus as unknown as Record<string, unknown>,
      recommendedAdminActions, warnings, errors,
    });
    await patchConfig({ lastHealthCheckAt: new Date(), currentSafetyLock: safetyStatus.hardBlocks.length ? safetyStatus.hardBlocks[0]!.code : null });
  } catch (err) {
    errors.push(`failed to persist health check: ${String(err).slice(0, 120)}`);
    // The returned report must agree with its own errors list.
    overallStatus = deriveOverall();
    report.overallStatus = overallStatus;
    const i = recommendedAdminActions.indexOf(HEALTHY_ACTION);
    if (i >= 0) recommendedAdminActions.splice(i, 1);
  }

  await auditEvent({
    eventType: "HEALTH_CHECK_COMPLETED",
    severity: overallStatus === "HEALTHY" ? "INFO" : overallStatus === "DEGRADED" ? "WARNING" : "HIGH",
    sourceBuild: "MM", sourceService: "system-health", action: "complete-health-check",
    targetType: "health_check", targetId: id,
    metadata: { overallStatus, warnings: warnings.length, errors: errors.length, hardBlocks: safetyStatus.hardBlocks.length },
  });

  return report;
}

async function safe(fn: () => Promise<SubsystemReport>): Promise<SubsystemReport> {
  try { return await fn(); }
  catch (err) { return { status: "DEGRADED", notes: [`probe error: ${String(err).slice(0, 120)}`] }; }
}

export async function runSubsystemCheck(build: SubsystemBuild): Promise<SubsystemReport> {
  const map: Record<SubsystemBuild, () => Promise<SubsystemReport>> = {
    AA: probeAA, BB: probeBB, CC: probeCC, DD: probeDD, EE: probeEE, FF: probeFF,
    GG: probeGG, HH: probeHH, II: probeII, JJ: probeJJ, KK: probeKK, LL: probeLL,
  };
  const r = await safe(map[build]);
  await auditEvent({ eventType: "SUBSYSTEM_CHECK", severity: "INFO", sourceBuild: build, sourceService: "system-health", action: "check-subsystem", metadata: { status: r.status } });
  return r;
}

export async function listHealthChecks(limit = 20) {
  return db.select().from(systemHealthChecksTable).orderBy(desc(systemHealthChecksTable.createdAt)).limit(Math.min(Math.max(limit, 1), 200));
}

export async function exportHealthReport(): Promise<{ exportId: string; generatedAt: string; report: HealthCheckReport; config: Awaited<ReturnType<typeof getConfig>> }> {
  const report = await runHealthCheck();
  const config = await getConfig();
  return { exportId: `hcexp_${randomUUID()}`, generatedAt: new Date().toISOString(), report, config };
}

// ── Touch unused imports so type-check confirms them as live deps ──────────
// broker_health_state is owned by lib/brokerHub/brokerHealthState.ts and is
// not referenced here (ci guard single-broker-state-source).
export const _wiring = { demoPositionColumns, mt5CommandsTable, notificationLogsTable };

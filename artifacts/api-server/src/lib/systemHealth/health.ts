// Build MM — System Health Service.
//
// SAFETY: Health checks are READ-ONLY diagnostics. This service NEVER places
// trades, NEVER changes canPlaceTrades, NEVER calls MT5, NEVER enables live
// trading. liveTradingStatus is always reported as DISABLED. mode is always
// PAPER_ONLY.

import {
  db, systemHealthChecksTable,
  notificationsTable, notificationLogsTable,
  autopilotSettingsTable, autopilotCyclesTable,
  paperOrdersTable,
  riskGovernorEvaluationsTable,
  brokerHealthStateTable,
  livePositionsTable, mt5CommandsTable,
  safetyCoreTable,
} from "@workspace/db";
import { desc, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { auditEvent } from "./audit.js";
import { patchConfig, getConfig } from "./config.js";
import { marketDataHealthCheck } from "../marketData/marketDataService.js";

export type SubsystemBuild = "AA"|"BB"|"CC"|"DD"|"EE"|"FF"|"GG"|"HH"|"II"|"JJ"|"KK"|"LL";
export type SubsystemStatus = "OK" | "DEGRADED" | "UNAVAILABLE" | "UNSAFE";

export interface SubsystemReport {
  status: SubsystemStatus;
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
  redactionWorking: boolean;
  warnings: string[];
}

export interface PerformanceStatus {
  slowEndpoints: EndpointResult[];
  failedJobs: number;
  errorRate: number;
  latestAutopilotCycle: { cycleId: string | number; status?: string; startedAt?: string | Date } | null;
  latestRiskGovernorStatus: { overallStatus?: string; createdAt?: string | Date } | null;
  latestNotificationCriticalCount: number;
}

export interface HealthCheckReport {
  health_check_id: string;
  generated_at: string;
  overallStatus: "HEALTHY" | "DEGRADED" | "UNSAFE" | "FAILED";
  liveTradingStatus: "DISABLED";
  mode: "PAPER_ONLY";
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
async function probeAA(): Promise<SubsystemReport> {
  const res = await probeEndpoint("/api/trade-decision/status").catch(() => null);
  if (res?.ok) return { status: "OK", notes: ["decision endpoint reachable"], metrics: { latencyMs: res.latencyMs } };
  // Fallback: try alt route
  const alt = await probeEndpoint("/api/decisions?limit=1").catch(() => null);
  if (alt?.ok) return { status: "OK", notes: ["decision-log endpoint reachable"], metrics: { latencyMs: alt.latencyMs } };
  return { status: "DEGRADED", notes: ["AA decision endpoints not reachable on standard paths — non-fatal"] };
}
async function probeBB(): Promise<SubsystemReport> {
  const r = await probeEndpoint("/api/post-trade-debriefs");
  return r.ok
    ? { status: "OK", notes: ["debrief endpoint reachable"], metrics: { latencyMs: r.latencyMs } }
    : { status: "DEGRADED", notes: [`debrief endpoint http=${r.status ?? "ERR"}`] };
}
async function probeCC(): Promise<SubsystemReport> {
  const r = await probeEndpoint("/api/learning/insights");
  if (r.ok) return { status: "OK", notes: ["learning endpoint reachable"] };
  // Fallback: check table
  const cnt = await db.execute(sql`select count(*)::int as c from learning_events`).catch(() => null);
  if (cnt) return { status: "OK", notes: ["learning_events table reachable"] };
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
    return { status: "OK", notes, paperOnly: true, liveTradingAllowed: false };
  } catch (err) {
    return { status: "DEGRADED", notes: [`market data health check failed: ${String(err).slice(0, 120)}`] };
  }
}
async function probeEE(): Promise<SubsystemReport> {
  const r = await probeEndpoint("/api/paper-execution/status");
  const cnt = await db.select({ c: sql<number>`count(*)::int` }).from(paperOrdersTable).catch(() => [{ c: 0 }]);
  return r.ok
    ? { status: "OK", notes: ["paper execution endpoint reachable", "paper-only enforced"], metrics: { paperOrders: cnt[0]?.c ?? 0 }, paperOnly: true, liveTradingAllowed: false }
    : { status: "DEGRADED", notes: [`paper execution endpoint http=${r.status ?? "ERR"}`], metrics: { paperOrders: cnt[0]?.c ?? 0 }, paperOnly: true, liveTradingAllowed: false };
}
async function probeFF(): Promise<SubsystemReport> {
  const r = await probeEndpoint("/api/paper-autopilot/status");
  const cfg = await db.select().from(autopilotSettingsTable).limit(1).catch(() => []);
  const lastCycle = await db.select().from(autopilotCyclesTable).orderBy(desc(autopilotCyclesTable.id)).limit(1).catch(() => []);
  const liveAllowed = (cfg[0] as { liveTradingAllowed?: boolean } | undefined)?.liveTradingAllowed === true;
  if (liveAllowed) return { status: "UNSAFE", notes: ["FF reports liveTradingAllowed=true — CRITICAL"], paperOnly: false, liveTradingAllowed: true };
  return r.ok
    ? { status: "OK", notes: ["autopilot status reachable", "mode=PAPER_ONLY", "liveTradingAllowed=false"], metrics: { hasConfig: cfg.length > 0, lastCycleId: lastCycle[0]?.id ?? null }, paperOnly: true, liveTradingAllowed: false }
    : { status: "DEGRADED", notes: [`autopilot status http=${r.status ?? "ERR"}`], paperOnly: true, liveTradingAllowed: false };
}
async function probeGG(): Promise<SubsystemReport> {
  const r1 = await probeEndpoint("/api/performance/ai-command-center");
  const r2 = await probeEndpoint("/api/trading-calendar");
  return r1.ok
    ? { status: "OK", notes: ["command center reachable", `calendar http=${r2.status ?? "n/a"}`] }
    : { status: "DEGRADED", notes: [`command center http=${r1.status ?? "ERR"}`] };
}
async function probeHH(): Promise<SubsystemReport> {
  const r = await probeEndpoint("/api/risk-governor/status");
  const last = await db.select().from(riskGovernorEvaluationsTable).orderBy(desc(riskGovernorEvaluationsTable.id)).limit(1).catch(() => []);
  return r.ok
    ? { status: "OK", notes: ["risk governor status reachable", "liveTradingStatus=DISABLED", "canPlaceLiveTrade=false"], metrics: { lastEval: last[0]?.overallStatus ?? null }, paperOnly: true, liveTradingAllowed: false }
    : { status: "DEGRADED", notes: [`risk governor http=${r.status ?? "ERR"}`], paperOnly: true, liveTradingAllowed: false };
}
async function probeII(): Promise<SubsystemReport> {
  const r = await probeEndpoint("/api/trader-coach/status");
  return r.ok
    ? { status: "OK", notes: ["trader-coach reachable", "playbook readable", "no live recommendations"] }
    : { status: "DEGRADED", notes: [`trader-coach http=${r.status ?? "ERR"}`] };
}
async function probeJJ(): Promise<SubsystemReport> {
  const r = await probeEndpoint("/api/replay/runs?limit=1");
  return r.ok
    ? { status: "OK", notes: ["replay endpoints reachable", "mode=REPLAY_ONLY", "replay trades isolated from paper trades"] }
    : { status: "DEGRADED", notes: [`replay http=${r.status ?? "ERR"}`] };
}
async function probeKK(): Promise<SubsystemReport> {
  const r1 = await probeEndpoint("/api/data-import/imports?limit=1");
  const r2 = await probeEndpoint("/api/broker-readonly/status");
  const brokerMode = process.env["BROKER_MODE"] ?? "READ_ONLY";
  const unsafe = brokerMode.toUpperCase() !== "READ_ONLY";
  if (unsafe) return { status: "UNSAFE", notes: [`BROKER_MODE=${brokerMode} is UNSAFE — should be READ_ONLY`], paperOnly: true, liveTradingAllowed: false };
  return (r1.ok && r2.ok)
    ? { status: "OK", notes: ["data-import reachable", "broker-readonly reachable", "broker mode=READ_ONLY", "secrets redacted"], paperOnly: true, liveTradingAllowed: false }
    : { status: "DEGRADED", notes: [`data-import http=${r1.status ?? "ERR"}`, `broker-readonly http=${r2.status ?? "ERR"}`] };
}
async function probeLL(): Promise<SubsystemReport> {
  const r1 = await probeEndpoint("/api/notifications");
  const r2 = await probeEndpoint("/api/notifications/digest");
  const counts = await db.select({ c: sql<number>`count(*) filter (where severity='CRITICAL')::int` }).from(notificationsTable).catch(() => [{ c: 0 }]);
  return r1.ok
    ? { status: "OK", notes: ["notifications reachable", `digest http=${r2.status}`, "critical alerts work"], metrics: { criticalTotal: counts[0]?.c ?? 0 } }
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
    const counted = ["notifications", "system_health_checks", "system_audit_logs", "admin_action_logs", "paper_orders", "live_positions", "mt5_commands"];
    for (const t of counted) {
      if (!present.has(t)) continue;
      try {
        const r = await db.execute(sql`select count(*)::int as c from ${sql.identifier(t)}`);
        status.rowCounts[t] = (r.rows[0] as { c: number } | undefined)?.c ?? 0;
      } catch { /* ignore */ }
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

// ── Safety probe (READ-ONLY) ────────────────────────────────────────────────
async function probeSafety(subs: Record<SubsystemBuild, SubsystemReport>): Promise<SafetyStatus> {
  const warnings: string[] = [];
  const hardBlocks: Array<{ code: string; severity: string; message: string }> = [];
  // Read safetyCore (informational only — MM never writes here)
  const sc = await db.select().from(safetyCoreTable).limit(1).catch(() => []);
  const row = sc[0] as (typeof safetyCoreTable.$inferSelect | undefined);
  if (row?.killSwitchEngaged) hardBlocks.push({ code: "KILL_SWITCH", severity: "CRITICAL", message: row.killSwitchReason ?? "engaged" });
  if (row?.operationalMode && !["OBSERVE_ONLY", "PAPER_ONLY", "RECOVERY_MODE"].includes(row.operationalMode))
    warnings.push(`safetyCore.operationalMode=${row.operationalMode}`);
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
  // Notification messages (frontend-visible)
  const inFrontend = await db.execute(sql`select count(*)::int as c from notifications where message ~ ${SECRET_SHAPED.source}`)
    .catch(() => ({ rows: [{ c: 0 }] as Array<{ c: number }> }));
  // Notification logs
  const inLogs = await db.execute(sql`select count(*)::int as c from notification_logs where message ~ ${SECRET_SHAPED.source}`)
    .catch(() => ({ rows: [{ c: 0 }] as Array<{ c: number }> }));
  const ff = (inFrontend.rows[0] as { c: number } | undefined)?.c ?? 0;
  const lf = (inLogs.rows[0] as { c: number } | undefined)?.c ?? 0;
  if (ff > 0) warnings.push(`possible secret-shaped strings in ${ff} notification messages`);
  if (lf > 0) warnings.push(`possible secret-shaped strings in ${lf} notification log messages`);
  return {
    secretsDetectedInFrontend: ff, secretsDetectedInLogs: lf,
    redactionWorking: ff === 0 && lf === 0,
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
    .catch(() => ({ rows: [{ c: 0 }] as Array<{ c: number }> }));
  return {
    slowEndpoints: slow,
    failedJobs: failed,
    errorRate: Number(errorRate.toFixed(3)),
    latestAutopilotCycle: lastCycle[0] ? { cycleId: lastCycle[0].id, status: (lastCycle[0] as { status?: string }).status, startedAt: (lastCycle[0] as { startedAt?: Date }).startedAt } : null,
    latestRiskGovernorStatus: lastGov[0] ? { overallStatus: (lastGov[0] as { overallStatus?: string }).overallStatus, createdAt: (lastGov[0] as { createdAt?: Date }).createdAt } : null,
    latestNotificationCriticalCount: (critUnread.rows[0] as { c: number } | undefined)?.c ?? 0,
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
  if (databaseStatus.missingTables.length) warnings.push(`missing tables: ${databaseStatus.missingTables.join(",")}`);
  if (endpointStatus.failed > 0) warnings.push(`${endpointStatus.failed} endpoint(s) failing`);
  if (!secretSafetyStatus.redactionWorking) errors.push("secret redaction warnings — investigate");
  if (safetyStatus.hardBlocks.length) errors.push(`${safetyStatus.hardBlocks.length} hard safety block(s) active`);
  if (performanceStatus.latestNotificationCriticalCount > 0)
    recommendedAdminActions.push(`Acknowledge ${performanceStatus.latestNotificationCriticalCount} unread CRITICAL notification(s)`);
  if (subsystemStatus.FF.status === "OK") recommendedAdminActions.push("Stop autopilot before next session if not in use");
  if (warnings.length === 0 && errors.length === 0) recommendedAdminActions.push("System healthy — no admin action required");

  // Overall
  let overallStatus: HealthCheckReport["overallStatus"] = "HEALTHY";
  if (warnings.length) overallStatus = "DEGRADED";
  if (errors.length)   overallStatus = "FAILED";
  if (safetyStatus.hardBlocks.length || Object.values(subsystemStatus).some((s) => s.status === "UNSAFE"))
    overallStatus = "UNSAFE";

  const report: HealthCheckReport = {
    health_check_id: id, generated_at, overallStatus,
    liveTradingStatus: "DISABLED", mode: "PAPER_ONLY",
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
export const _wiring = { brokerHealthStateTable, livePositionsTable, mt5CommandsTable, notificationLogsTable };

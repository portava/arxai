// Capability #28 — Independent Protection Watchdog: a SEPARATE process.
//
// This is its own entrypoint. It is NOT imported by the api-server and does
// NOT import the api-server: no app.ts, no routes, no workers, no
// @workspace/db singleton — its entire dependency surface is `pg` plus the
// pure assessment core (watchdogCore.ts). Run it as its own process:
//
//   pnpm run watchdog                 # loop mode (default 60s interval)
//   pnpm run watchdog:once            # one pass; exit code carries verdict
//
// WHY THIS EXISTS: every prior watchdog (bridge, feed-staleness, stuck
// commands) runs INSIDE the primary api-server process — when that process
// is the thing that died, they die with it. This process verifies from the
// outside: are open positions protected, are commands moving, is the main
// app writing its heartbeat evidence — and ALERTS when the answer is no or
// unknowable. Deployment topologies and what each one does NOT protect against
// are documented honestly in docs/WATCHDOG_DEPLOYMENT.md.
//
// SAFETY (inviolable):
//   - READ-ONLY, twice over: the session runs
//     `SET default_transaction_read_only = on` immediately after connecting
//     (Postgres then refuses any write on this connection), and the code
//     contains no INSERT/UPDATE/DELETE (pinned by the source-guard test).
//     Its own heartbeat is therefore written by the APP, not by this process.
//   - LIMITED AUTHORITY: alerting is the only output — structured stderr
//     logs, the product notification service over HTTP, and an optional
//     operator webhook. It cannot close, place, or modify anything, cannot
//     engage/release any switch, and holds no execution surface.
//   - UNVERIFIABLE ≠ HEALTHY: an unreachable database or failed query is a
//     CRITICAL cannot-verify alert, never a quiet pass — and the /healthz
//     port returns 503 in that state rather than a green tick.
//   - DELIVERY IS NEVER ASSUMED: a failed alert POST is logged as
//     `alert_delivery_degraded` with the reason. "We tried" is not "we told
//     the owner".
//   - Env opt-outs are logged loudly. Interval floor prevents a
//     misconfigured 0ms hot-loop.

import http from "node:http";
import os from "node:os";
import pg from "pg";
import {
  assessSnapshot,
  diffFindings,
  NON_TERMINAL_COMMAND_STATUSES,
  type Section,
  type WatchdogAssessment,
  type WatchdogCommandRow,
  type WatchdogFinding,
  type WatchdogPositionRow,
  type WatchdogSnapshot,
} from "./lib/protectiveWatchdog/watchdogCore.js";
import {
  buildAlertEnvelope,
  type WatchdogAlertEnvelope,
} from "./lib/protectiveWatchdog/watchdogAlertEnvelope.js";
import {
  alertSinkConfigFromEnv,
  deliverAlert,
  deliveryIsDegraded,
  summariseDelivery,
  type AlertSinkConfig,
} from "./lib/protectiveWatchdog/watchdogAlertSink.js";
import {
  handleWatchdogHealthRequest,
  newLivenessState,
  type WatchdogLivenessState,
} from "./lib/protectiveWatchdog/watchdogHealth.js";

const { Client } = pg;

export const WATCHDOG_DEFAULT_INTERVAL_MS = 60 * 1000;
export const WATCHDOG_MIN_INTERVAL_MS = 5 * 1000;
export const WATCHDOG_DEFAULT_HEALTH_PORT = 8091;

/** Self-reported deployment topology. It is a CLAIM, not a verified fact —
 *  nothing in-process can prove which box it is on. Documented as such. */
const TOPOLOGIES = new Set(["same_host", "second_repl", "external_host", "unknown"]);

function log(level: "info" | "warn" | "error", msg: string, extra: Record<string, unknown> = {}): void {
  // Structured single-line JSON on stderr — survives log scraping, needs no logger dep.
  process.stderr.write(JSON.stringify({ at: new Date().toISOString(), level, watchdog: true, msg, ...extra }) + "\n");
}

// ── Snapshot collection (SELECTs only) ──────────────────────────────────────

async function section<T>(fn: () => Promise<T>): Promise<Section<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

type Row = Record<string, unknown>;

function asDate(v: unknown): Date | null {
  return v instanceof Date ? v : typeof v === "string" && Number.isFinite(Date.parse(v)) ? new Date(v) : null;
}

async function collectSnapshot(client: InstanceType<typeof Client>): Promise<WatchdogSnapshot> {
  const openPositions = await section<WatchdogPositionRow[]>(async () => {
    const r = await client.query(
      `SELECT id, user_id, symbol, direction, lot_size, stop_loss, status, closed_at, last_synced_at
         FROM live_positions
        WHERE closed_at IS NULL
        ORDER BY id DESC
        LIMIT 500`,
    );
    return (r.rows as Row[]).map((row) => ({
      id: Number(row.id),
      userId: row.user_id == null ? null : Number(row.user_id),
      symbol: String(row.symbol),
      direction: String(row.direction),
      lotSize: Number(row.lot_size),
      stopLoss: row.stop_loss == null ? null : Number(row.stop_loss),
      status: String(row.status),
      closedAt: asDate(row.closed_at),
      lastSyncedAt: asDate(row.last_synced_at),
    }));
  });

  const nonTerminalCommands = await section<WatchdogCommandRow[]>(async () => {
    const r = await client.query(
      `SELECT id, status, action, created_at
         FROM mt5_commands
        WHERE status = ANY($1)
        ORDER BY id DESC
        LIMIT 500`,
      [[...NON_TERMINAL_COMMAND_STATUSES]],
    );
    return (r.rows as Row[]).map((row) => ({
      id: Number(row.id),
      status: String(row.status),
      action: String(row.action),
      createdAt: asDate(row.created_at),
    }));
  });

  const latestHealthCheckAt = await section<Date | null>(async () => {
    const r = await client.query(`SELECT max(created_at) AS newest FROM system_health_checks`);
    return asDate((r.rows[0] as Row | undefined)?.newest);
  });

  const latestAuditEventAt = await section<Date | null>(async () => {
    const r = await client.query(`SELECT max(created_at) AS newest FROM audit_events`);
    return asDate((r.rows[0] as Row | undefined)?.newest);
  });

  const killSwitchEngaged = await section<boolean | null>(async () => {
    const r = await client.query(`SELECT kill_switch_engaged FROM safety_core ORDER BY id LIMIT 1`);
    const row = r.rows[0] as Row | undefined;
    return row === undefined ? null : row.kill_switch_engaged === true;
  });

  return { openPositions, nonTerminalCommands, latestHealthCheckAt, latestAuditEventAt, killSwitchEngaged };
}

// ── Alert delivery ──────────────────────────────────────────────────────────
//
// Two legs, in order: the product's notification service (what the owner
// actually looks at), then an optional independent operator webhook. Neither
// is assumed to have worked — `deliverAlert` returns a typed per-leg result
// and a failure is logged as a degraded alert path, never swallowed.

function logFindings(findings: readonly WatchdogFinding[]): void {
  for (const f of findings) {
    log(f.severity === "CRITICAL" ? "error" : f.severity === "WARN" ? "warn" : "info", "watchdog_finding", {
      key: f.key,
      severity: f.severity,
      message: f.message,
      evidence: f.evidence,
    });
  }
}

async function deliverEnvelope(envelope: WatchdogAlertEnvelope, config: AlertSinkConfig): Promise<{ summary: string; degraded: boolean }> {
  const results = await deliverAlert(envelope, config, fetch as never);
  const summary = summariseDelivery(results);
  const degraded = deliveryIsDegraded(results);
  for (const r of results) {
    if (r.status === "delivered") continue;
    const reason = "reason" in r ? r.reason : `http_${"httpStatus" in r ? r.httpStatus : "?"}`;
    // A CANNOT_VERIFY or CRITICAL pass whose alert did not land is the worst
    // case in the whole capability: log it at error, not warn.
    const level = r.leg === "app" && envelope.findings.length > 0 ? "error" : "warn";
    log(level, "alert_delivery_degraded", { leg: r.leg, status: r.status, reason, findings: envelope.findings.length });
  }
  return { summary, degraded };
}

// ── One pass ────────────────────────────────────────────────────────────────

export interface PassResult {
  assessment: WatchdogAssessment | null;
  dbUnreachable: boolean;
}

interface PassDeps {
  databaseUrl: string;
  previousKeys: string[];
  sinkConfig: AlertSinkConfig;
  state: WatchdogLivenessState;
}

async function finishPass(
  deps: PassDeps,
  activeFindings: readonly WatchdogFinding[],
  newFindings: readonly WatchdogFinding[],
  activeKeys: string[],
): Promise<void> {
  const nowMs = Date.now();
  const envelope = buildAlertEnvelope({
    instanceId: deps.state.instanceId,
    topology: deps.state.topology,
    activeFindings,
    newFindings,
    nowMs,
    uptimeSeconds: (nowMs - deps.state.startedAtMs) / 1000,
  });
  const delivery = await deliverEnvelope(envelope, deps.sinkConfig);

  deps.state.lastPassCompletedAtMs = nowMs;
  deps.state.lastVerdict = envelope.passVerdict;
  deps.state.activeFindingKeys = activeKeys;
  deps.state.lastDeliverySummary = delivery.summary;
  deps.state.lastDeliveryDegraded = delivery.degraded;
  deps.state.passCount += 1;
  deps.state.consecutiveCannotVerify = envelope.passVerdict === "CANNOT_VERIFY" ? deps.state.consecutiveCannotVerify + 1 : 0;
  deps.state.lastCannotVerifyReason = envelope.passVerdict === "CANNOT_VERIFY"
    ? (activeFindings.find((f) => f.key.startsWith("cannot_verify:"))?.message ?? "unspecified")
    : null;
}

async function runOnePass(deps: PassDeps): Promise<PassResult & { activeKeys: string[] }> {
  const { databaseUrl, previousKeys } = deps;
  const client = new Client({ connectionString: databaseUrl, statement_timeout: 15_000 });
  try {
    await client.connect();
    // READ-ONLY session — Postgres itself will refuse any write from here on.
    await client.query(`SET default_transaction_read_only = on`);
  } catch (err) {
    // The one condition the watchdog exists for: it cannot see. Alert, do not pass.
    const finding: WatchdogFinding = {
      key: "cannot_verify:database_connection",
      severity: "CRITICAL",
      message: `watchdog cannot reach the database — protection state is UNVERIFIABLE (${err instanceof Error ? err.message : String(err)})`,
      evidence: {},
    };
    const delta = diffFindings(previousKeys, [finding]);
    logFindings(delta.newFindings);
    try { await client.end(); } catch { /* already dead */ }
    await finishPass(deps, [finding], delta.newFindings, delta.activeKeys);
    return { assessment: null, dbUnreachable: true, activeKeys: delta.activeKeys };
  }

  try {
    const snapshot = await collectSnapshot(client);
    const assessment = assessSnapshot(snapshot, Date.now());
    const delta = diffFindings(previousKeys, assessment.findings);
    logFindings(delta.newFindings);
    for (const k of delta.resolvedKeys) log("info", "watchdog_finding_resolved", { key: k });
    if (assessment.verifiedHealthy && previousKeys.length === 0) {
      // Quiet when healthy — a heartbeat line only, no alert noise.
      log("info", "watchdog_pass_verified_healthy", {
        openPositions: snapshot.openPositions.ok ? snapshot.openPositions.value.length : "unreadable",
      });
    }
    await finishPass(deps, assessment.findings, delta.newFindings, delta.activeKeys);
    return { assessment, dbUnreachable: false, activeKeys: delta.activeKeys };
  } finally {
    try { await client.end(); } catch { /* connection teardown best-effort */ }
  }
}

// ── The watchdog's own liveness port ────────────────────────────────────────
//
// A watchdog nobody watches can die silently. This exposes /healthz (503
// unless the last pass actually READ everything) and /livez (process liveness
// only). Binding failure degrades loudly and does NOT kill the watchdog —
// losing the probe must never cost us the watching.

function startHealthServer(state: WatchdogLivenessState, port: number, host: string): http.Server | null {
  const server = http.createServer((req, res) => {
    const pathname = (req.url ?? "/").split("?")[0] ?? "/";
    const out = handleWatchdogHealthRequest(pathname, state, Date.now());
    const body = JSON.stringify(out.body);
    res.writeHead(out.httpStatus, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(body);
  });
  server.on("error", (err) => {
    log("error", "watchdog_health_port_unavailable", {
      port, host,
      err: err instanceof Error ? err.message : String(err),
      detail: "the watchdog is STILL WATCHING; only its own liveness probe is unavailable",
    });
  });
  try {
    server.listen(port, host, () => {
      log("info", "watchdog_health_listening", { port, host, paths: ["/healthz", "/livez"] });
    });
    return server;
  } catch (err) {
    log("error", "watchdog_health_listen_threw", { err: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

// ── Entry ───────────────────────────────────────────────────────────────────

function resolveIntervalMs(raw: string | undefined): number {
  const n = raw === undefined ? WATCHDOG_DEFAULT_INTERVAL_MS : Number(raw);
  if (!Number.isFinite(n) || n < WATCHDOG_MIN_INTERVAL_MS) return WATCHDOG_DEFAULT_INTERVAL_MS;
  return n;
}

export function resolveTopology(raw: string | undefined): string {
  const v = String(raw ?? "").trim().toLowerCase();
  return TOPOLOGIES.has(v) ? v : "unknown";
}

export function resolveInstanceId(raw: string | undefined): string {
  const v = String(raw ?? "").trim();
  if (v.length > 0) return v.replace(/[^a-zA-Z0-9._:-]/g, "_").slice(0, 64);
  // Derived, not invented: host + pid identify the actual running process.
  return `${os.hostname()}:${process.pid}`.replace(/[^a-zA-Z0-9._:-]/g, "_").slice(0, 64);
}

function resolveHealthPort(raw: string | undefined): number {
  const n = raw === undefined ? WATCHDOG_DEFAULT_HEALTH_PORT : Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return WATCHDOG_DEFAULT_HEALTH_PORT;
  return n;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.ARX_WATCHDOG_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    log("error", "watchdog_cannot_start_no_database_url", {
      detail: "Set ARX_WATCHDOG_DATABASE_URL (preferred: a read-only role — see docs/WATCHDOG_DEPLOYMENT.md) or DATABASE_URL.",
    });
    process.exit(2);
  }
  const once = process.argv.includes("--once");
  const intervalMs = resolveIntervalMs(process.env.ARX_WATCHDOG_INTERVAL_MS);
  const sinkConfig = alertSinkConfigFromEnv(process.env);
  const instanceId = resolveInstanceId(process.env.ARX_WATCHDOG_INSTANCE_ID);
  const topology = resolveTopology(process.env.ARX_WATCHDOG_TOPOLOGY);

  // Every unarmed leg of the alert path is announced at startup. A watchdog
  // whose alerts reach nobody must never be able to look configured.
  if (!sinkConfig.ingestUrl || !sinkConfig.ingestToken) {
    log("warn", "watchdog_alert_path_not_armed", {
      ingestUrlSet: Boolean(sinkConfig.ingestUrl),
      ingestTokenSet: Boolean(sinkConfig.ingestToken),
      detail: "findings will NOT reach the in-app notification service. Set ARX_WATCHDOG_ALERT_INGEST_URL and ARX_WATCHDOG_INGEST_TOKEN (owner press — docs/WATCHDOG_DEPLOYMENT.md).",
    });
  }
  if (!sinkConfig.webhookUrl) {
    log("warn", "watchdog_no_webhook_configured", {
      detail: "no independent operator webhook. If the app is down, findings reach the owner only through this process's logs and /healthz.",
    });
  }
  if (topology === "unknown") {
    log("warn", "watchdog_topology_unstated", {
      detail: "ARX_WATCHDOG_TOPOLOGY is unset. Set same_host | second_repl | external_host so the heartbeat records which failure domain this instance actually covers.",
    });
  }

  const state = newLivenessState({ instanceId, topology, startedAtMs: Date.now(), intervalMs });

  log("info", "watchdog_started", {
    once, intervalMs, instanceId, topology,
    separateProcess: true, readOnly: true,
    alertLegs: { app: Boolean(sinkConfig.ingestUrl && sinkConfig.ingestToken), webhook: Boolean(sinkConfig.webhookUrl) },
  });

  let previousKeys: string[] = [];
  if (once) {
    const r = await runOnePass({ databaseUrl, previousKeys, sinkConfig, state });
    if (r.dbUnreachable) process.exit(2);
    if (r.assessment && r.assessment.criticalCount > 0) process.exit(1);
    process.exit(0);
  }

  // Loop mode only: the probe port exists to be scraped over time.
  const healthServer = startHealthServer(state, resolveHealthPort(process.env.ARX_WATCHDOG_HEALTH_PORT), process.env.ARX_WATCHDOG_HEALTH_HOST ?? "0.0.0.0");

  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return; // never overlap a slow pass
    running = true;
    try {
      const r = await runOnePass({ databaseUrl, previousKeys, sinkConfig, state });
      previousKeys = r.activeKeys;
    } catch (err) {
      log("error", "watchdog_pass_crashed", { err: err instanceof Error ? err.message : String(err) });
    } finally {
      running = false;
    }
  };
  await tick();
  // Deliberately NOT unref'd: this interval IS the process.
  setInterval(() => { void tick(); }, intervalMs);

  const shutdown = (signal: string): void => {
    log("warn", "watchdog_stopping", { signal, detail: "protection is no longer being independently verified from this process" });
    healthServer?.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

void main();

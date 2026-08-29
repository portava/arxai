// Capability #28 — Independent Protection Watchdog: a SEPARATE process.
//
// This is its own entrypoint. It is NOT imported by the api-server and does
// NOT import the api-server: no app.ts, no routes, no workers, no
// @workspace/db singleton — its entire dependency surface is `pg` plus the
// pure assessment core (watchdogCore.ts). Run it as its own process:
//
//   pnpm run watchdog                 # loop mode (default 60s interval)
//   pnpm run watchdog -- --once       # one pass; exit code carries verdict
//
// WHY THIS EXISTS: every prior watchdog (bridge, feed-staleness, stuck
// commands) runs INSIDE the primary api-server process — when that process
// is the thing that died, they die with it. This process verifies from the
// outside: are open positions protected, are commands moving, is the main
// app writing its heartbeat evidence — and ALERTS when the answer is no or
// unknowable. Deployment options (same host vs a second Repl/host — an owner
// decision) are documented honestly in docs/WATCHDOG.md.
//
// SAFETY (inviolable):
//   - READ-ONLY, twice over: the session runs
//     `SET default_transaction_read_only = on` immediately after connecting
//     (Postgres then refuses any write on this connection), and the code
//     contains no INSERT/UPDATE/DELETE (pinned by the source-guard test).
//   - LIMITED AUTHORITY: alerting is the only output — structured stderr
//     logs plus an optional operator webhook. It cannot close, place, or
//     modify anything, cannot engage/release any switch, and holds no
//     execution surface to be confused into using.
//   - UNVERIFIABLE ≠ HEALTHY: an unreachable database or failed query is a
//     CRITICAL cannot-verify alert, never a quiet pass.
//   - Env opt-outs are logged loudly. Interval floor prevents a
//     misconfigured 0ms hot-loop.

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

const { Client } = pg;

export const WATCHDOG_DEFAULT_INTERVAL_MS = 60 * 1000;
export const WATCHDOG_MIN_INTERVAL_MS = 5 * 1000;

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

async function deliverWebhook(webhookUrl: string, body: Record<string, unknown>): Promise<void> {
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) log("warn", "webhook_delivery_non_ok", { status: res.status });
  } catch (err) {
    log("warn", "webhook_delivery_failed", { err: err instanceof Error ? err.message : String(err) });
  }
}

function emitAlerts(findings: readonly WatchdogFinding[], webhookUrl: string | null): void {
  for (const f of findings) {
    log(f.severity === "CRITICAL" ? "error" : f.severity === "WARN" ? "warn" : "info", "watchdog_finding", {
      key: f.key,
      severity: f.severity,
      message: f.message,
      evidence: f.evidence,
    });
  }
  if (webhookUrl && findings.length > 0) {
    void deliverWebhook(webhookUrl, {
      source: "arx-protection-watchdog",
      at: new Date().toISOString(),
      findings: findings.map((f) => ({ key: f.key, severity: f.severity, message: f.message })),
    });
  }
}

// ── One pass ────────────────────────────────────────────────────────────────

export interface PassResult {
  assessment: WatchdogAssessment | null;
  dbUnreachable: boolean;
}

async function runOnePass(databaseUrl: string, previousKeys: string[], webhookUrl: string | null): Promise<PassResult & { activeKeys: string[] }> {
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
    emitAlerts(delta.newFindings, webhookUrl);
    try { await client.end(); } catch { /* already dead */ }
    return { assessment: null, dbUnreachable: true, activeKeys: delta.activeKeys };
  }

  try {
    const snapshot = await collectSnapshot(client);
    const assessment = assessSnapshot(snapshot, Date.now());
    const delta = diffFindings(previousKeys, assessment.findings);
    emitAlerts(delta.newFindings, webhookUrl);
    for (const k of delta.resolvedKeys) log("info", "watchdog_finding_resolved", { key: k });
    if (assessment.verifiedHealthy && previousKeys.length === 0) {
      // Quiet when healthy — a heartbeat line only, no alert noise.
      log("info", "watchdog_pass_verified_healthy", {
        openPositions: snapshot.openPositions.ok ? snapshot.openPositions.value.length : "unreadable",
      });
    }
    return { assessment, dbUnreachable: false, activeKeys: delta.activeKeys };
  } finally {
    try { await client.end(); } catch { /* connection teardown best-effort */ }
  }
}

// ── Entry ───────────────────────────────────────────────────────────────────

function resolveIntervalMs(raw: string | undefined): number {
  const n = raw === undefined ? WATCHDOG_DEFAULT_INTERVAL_MS : Number(raw);
  if (!Number.isFinite(n) || n < WATCHDOG_MIN_INTERVAL_MS) return WATCHDOG_DEFAULT_INTERVAL_MS;
  return n;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.ARX_WATCHDOG_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    log("error", "watchdog_cannot_start_no_database_url", {
      detail: "Set ARX_WATCHDOG_DATABASE_URL (preferred: a read-only role — see docs/WATCHDOG.md) or DATABASE_URL.",
    });
    process.exit(2);
  }
  const webhookUrl = process.env.ARX_WATCHDOG_WEBHOOK_URL ?? null;
  if (!webhookUrl) {
    log("warn", "watchdog_no_webhook_configured — findings go to structured logs only (set ARX_WATCHDOG_WEBHOOK_URL for operator push alerts)");
  }
  const once = process.argv.includes("--once");
  const intervalMs = resolveIntervalMs(process.env.ARX_WATCHDOG_INTERVAL_MS);

  log("info", "watchdog_started", { once, intervalMs, separateProcess: true, readOnly: true });

  let previousKeys: string[] = [];
  if (once) {
    const r = await runOnePass(databaseUrl, previousKeys, webhookUrl);
    if (r.dbUnreachable) process.exit(2);
    if (r.assessment && r.assessment.criticalCount > 0) process.exit(1);
    process.exit(0);
  }

  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return; // never overlap a slow pass
    running = true;
    try {
      const r = await runOnePass(databaseUrl, previousKeys, webhookUrl);
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
}

void main();

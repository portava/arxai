// Capability #28 — Independent Protection Watchdog test suite.
//
// Proves, offline and deterministically:
//   1. Unprotected open positions, stale syncs, stuck commands, and a silent
//      main app each produce the right finding at the right severity.
//   2. UNVERIFIABLE ≠ HEALTHY: any unreadable section is a CRITICAL
//      cannot_verify finding — the watchdog can never quietly pass on a read
//      failure.
//   3. Repeat-suppression diffs findings by stable key and announces
//      resolutions.
//   4. SEPARATION PINS (source guards on watchdog.ts):
//      - imports ONLY `pg` + the pure core (no app modules, no
//        @workspace/db singleton, no routes/workers/audit vault),
//      - forces `default_transaction_read_only = on` on its own session,
//      - contains no INSERT/UPDATE/DELETE statement.
//
// Run: pnpm --filter @workspace/api-server run test:protection-watchdog

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  MAIN_APP_SILENT_MS,
  STALE_POSITION_SYNC_MS,
  STUCK_COMMAND_MS,
  assessSnapshot,
  diffFindings,
  type WatchdogPositionRow,
  type WatchdogSnapshot,
} from "../watchdogCore.js";

const NOW = Date.parse("2026-08-29T12:00:00Z");

function position(overrides: Partial<WatchdogPositionRow> = {}): WatchdogPositionRow {
  return {
    id: 1,
    userId: 7,
    symbol: "EURUSD",
    direction: "BUY",
    lotSize: 0.1,
    stopLoss: 1.08,
    status: "OPEN",
    closedAt: null,
    lastSyncedAt: new Date(NOW - 30_000),
    ...overrides,
  };
}

function healthySnapshot(overrides: Partial<WatchdogSnapshot> = {}): WatchdogSnapshot {
  return {
    openPositions: { ok: true, value: [position()] },
    nonTerminalCommands: { ok: true, value: [] },
    latestHealthCheckAt: { ok: true, value: new Date(NOW - 60_000) },
    latestAuditEventAt: { ok: true, value: new Date(NOW - 30_000) },
    killSwitchEngaged: { ok: true, value: false },
    ...overrides,
  };
}

// ── 1. Findings ─────────────────────────────────────────────────────────────

test("a fully readable, protected, live snapshot is verified healthy with zero findings", () => {
  const a = assessSnapshot(healthySnapshot(), NOW);
  assert.equal(a.verifiedHealthy, true);
  assert.deepEqual(a.findings, []);
});

test("an open position with no stop loss is CRITICAL", () => {
  const a = assessSnapshot(
    healthySnapshot({ openPositions: { ok: true, value: [position({ id: 42, stopLoss: null })] } }),
    NOW,
  );
  assert.equal(a.verifiedHealthy, false);
  const f = a.findings.find((x) => x.key === "unprotected_position:42");
  assert.ok(f, "expected an unprotected_position finding");
  assert.equal(f.severity, "CRITICAL");
});

test("stale and never-synced open positions WARN", () => {
  const a = assessSnapshot(
    healthySnapshot({
      openPositions: {
        ok: true,
        value: [
          position({ id: 1, lastSyncedAt: new Date(NOW - STALE_POSITION_SYNC_MS - 1000) }),
          position({ id: 2, lastSyncedAt: null }),
        ],
      },
    }),
    NOW,
  );
  assert.equal(a.findings.find((f) => f.key === "stale_position_sync:1")?.severity, "WARN");
  assert.equal(a.findings.find((f) => f.key === "never_synced_position:2")?.severity, "WARN");
  assert.equal(a.criticalCount, 0);
});

test("a command stuck non-terminal past the threshold WARNs; a fresh one does not", () => {
  const a = assessSnapshot(
    healthySnapshot({
      nonTerminalCommands: {
        ok: true,
        value: [
          { id: 10, status: "PENDING", action: "OPEN", createdAt: new Date(NOW - STUCK_COMMAND_MS - 1) },
          { id: 11, status: "PENDING", action: "OPEN", createdAt: new Date(NOW - 5_000) },
        ],
      },
    }),
    NOW,
  );
  assert.ok(a.findings.some((f) => f.key === "stuck_command:10" && f.severity === "WARN"));
  assert.ok(!a.findings.some((f) => f.key === "stuck_command:11"));
});

test("a silent main app (no health check or audit activity within threshold) is CRITICAL", () => {
  const old = new Date(NOW - MAIN_APP_SILENT_MS - 60_000);
  const a = assessSnapshot(
    healthySnapshot({
      latestHealthCheckAt: { ok: true, value: old },
      latestAuditEventAt: { ok: true, value: old },
    }),
    NOW,
  );
  assert.equal(a.findings.find((f) => f.key === "main_app_silent")?.severity, "CRITICAL");
});

test("engaged kill switch with open positions WARNs with the open count", () => {
  const a = assessSnapshot(healthySnapshot({ killSwitchEngaged: { ok: true, value: true } }), NOW);
  const f = a.findings.find((x) => x.key === "kill_switch_engaged");
  assert.ok(f);
  assert.equal(f.severity, "WARN");
  assert.equal(f.evidence.openPositions, 1);
});

// ── 2. Unverifiable ≠ healthy ───────────────────────────────────────────────

test("EVERY unreadable section yields a CRITICAL cannot_verify finding — never a quiet pass", () => {
  const broken: WatchdogSnapshot = {
    openPositions: { ok: false, reason: "connection refused" },
    nonTerminalCommands: { ok: false, reason: "connection refused" },
    latestHealthCheckAt: { ok: false, reason: "connection refused" },
    latestAuditEventAt: { ok: false, reason: "connection refused" },
    killSwitchEngaged: { ok: false, reason: "connection refused" },
  };
  const a = assessSnapshot(broken, NOW);
  assert.equal(a.verifiedHealthy, false);
  assert.ok(a.cannotVerifyCount >= 4, `expected cannot_verify findings for every section, got ${a.cannotVerifyCount}`);
  for (const f of a.findings.filter((x) => x.key.startsWith("cannot_verify:"))) {
    assert.equal(f.severity, "CRITICAL");
  }
});

test("one unreadable section does not silence the others' real findings", () => {
  const a = assessSnapshot(
    healthySnapshot({
      openPositions: { ok: false, reason: "timeout" },
      nonTerminalCommands: {
        ok: true,
        value: [{ id: 10, status: "PENDING", action: "OPEN", createdAt: new Date(NOW - STUCK_COMMAND_MS - 1) }],
      },
    }),
    NOW,
  );
  assert.ok(a.findings.some((f) => f.key === "cannot_verify:open_positions"));
  assert.ok(a.findings.some((f) => f.key === "stuck_command:10"));
});

// ── 3. Repeat suppression ───────────────────────────────────────────────────

test("diffFindings alerts a condition once and announces its resolution", () => {
  const a1 = assessSnapshot(
    healthySnapshot({ openPositions: { ok: true, value: [position({ id: 42, stopLoss: null })] } }),
    NOW,
  );
  const d1 = diffFindings([], a1.findings);
  assert.equal(d1.newFindings.length, 1);

  // Same condition next pass → no new alert.
  const d2 = diffFindings(d1.activeKeys, a1.findings);
  assert.equal(d2.newFindings.length, 0);

  // Condition resolved → resolution announced.
  const healthy = assessSnapshot(healthySnapshot(), NOW);
  const d3 = diffFindings(d2.activeKeys, healthy.findings);
  assert.deepEqual(d3.resolvedKeys, ["unprotected_position:42"]);
});

// ── 4. Separation pins (source guards) ──────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WATCHDOG_ENTRY = path.resolve(HERE, "../../../watchdog.ts");
const entrySrc = readFileSync(WATCHDOG_ENTRY, "utf8");

test("watchdog.ts imports only pg + the pure core — no app modules, no @workspace/db singleton", () => {
  // Multi-line-safe: every module specifier in an import ... from "<src>".
  const sources = [...entrySrc.matchAll(/^import[\s\S]*?from\s+["']([^"']+)["'];/gm)].map((m) => m[1]!);
  assert.deepEqual(
    sources.sort(),
    ["./lib/protectiveWatchdog/watchdogCore.js", "pg"].sort(),
    `watchdog entry imports must stay minimal, got: ${sources.join(", ")}`,
  );
  // Prohibited import targets — checked against the specifier list (comments
  // may MENTION them; the module may not IMPORT them).
  for (const banned of ["@workspace/db", "./app", "auditVault", "routes", "missionDriver"]) {
    assert.ok(!sources.some((s) => s.includes(banned)), `must not import ${banned} — own connection, no app modules`);
  }
});

test("watchdog.ts forces a read-only session and contains no write statement", () => {
  assert.ok(
    entrySrc.includes("SET default_transaction_read_only = on"),
    "the session must be forced read-only immediately after connect",
  );
  assert.ok(!/\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|TRUNCATE|CREATE\s+TABLE|DROP\s+)/i.test(entrySrc),
    "no write/DDL SQL may exist in the watchdog");
});

test("no api-server runtime file imports the watchdog entry (it is a separate process, not a worker)", () => {
  const indexSrc = readFileSync(path.resolve(HERE, "../../../index.ts"), "utf8");
  const appSrc = readFileSync(path.resolve(HERE, "../../../app.ts"), "utf8");
  assert.ok(!indexSrc.includes("watchdog.js") && !indexSrc.includes("watchdog.ts"), "index.ts must not start the watchdog in-process");
  assert.ok(!appSrc.includes("protectiveWatchdog"), "app.ts must not pull the watchdog in-process");
});

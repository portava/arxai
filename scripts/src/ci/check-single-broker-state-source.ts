// Broker Hub — one source for broker connection and account state (Tier 1).
//
// "Is the broker connected / what did the account report" is answered from
// stored broker state. Each such table has one reader inside lib/brokerHub/,
// and every other module reads through it, so ordering, ownership scoping and
// staleness labels are decided once. The hub stays read-only
// (broker-hub-no-execution), so the module that produces a table's rows
// writes it outside the hub, as the EA ingest does for mt5_state.
//
// This guard fails when a file outside lib/brokerHub/ names one of those
// tables (drizzle identifier) or queries it in raw SQL, unless the file is on
// the allowlist below with a reason. A "write" entry may insert/update the
// table but never select from it (it reads back through the hub). An
// allowlist entry that no longer touches its tables (or no longer exists) is
// stale and fails too, so the list only shrinks honestly.
//
// mt5_connection and mt5_state are guarded by broker-connection-single-owner
// and broker-state-single-reader; this guard checks those guards still exist
// rather than duplicating them.
// QA fixtures (__qa__, *.test.ts) are exempt; scripts under src/scripts are not.
//
// Pure source analysis: no network, no DB.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, walk, rel, reportResult, type CheckResult } from "./_lib.js";

const API_SRC = join(ROOT, "artifacts/api-server/src");
export const HUB_DIR = "lib/brokerHub/";

export interface StateTable {
  sql: string;
  drizzle: string;
  /** The file every read goes through (relative to artifacts/api-server/src). */
  owner: string;
}

export const STATE_TABLES: readonly StateTable[] = [
  { sql: "broker_health_state", drizzle: "brokerHealthStateTable", owner: "lib/brokerHub/brokerHealthState.ts" },
  { sql: "broker_health_logs", drizzle: "brokerHealthLogsTable", owner: "lib/brokerHub/brokerHealthState.ts" },
  { sql: "broker_readonly_snapshots", drizzle: "brokerReadonlySnapshotsTable", owner: "lib/brokerHub/readOnlySnapshots.ts" },
  { sql: "broker_readonly_logs", drizzle: "brokerReadonlyLogsTable", owner: "lib/brokerHub/readOnlySnapshots.ts" },
  // Allowlisted owners outside the hub today (see ALLOWLIST); listed so a new
  // reader anywhere else still fails.
  { sql: "arx_master_bridge_pool", drizzle: "arxMasterBridgePoolTable", owner: "lib/live/masterBridgePool.ts" },
  { sql: "bridge_v2_stream_state", drizzle: "bridgeV2StreamStateTable", owner: "lib/bridgeV2/status.ts" },
];

/** Tables guarded by their own Broker Hub guard. */
export const DELEGATED: ReadonlyArray<{ sql: string; guard: string }> = [
  { sql: "mt5_connection", guard: "scripts/src/ci/check-broker-connection-single-owner.ts" },
  { sql: "mt5_state", guard: "scripts/src/ci/check-broker-state-single-reader.ts" },
];

export interface AllowEntry {
  tables: readonly string[];
  /** "write": insert/update only, reads go through the owner. "readwrite": not yet behind the hub. */
  access: "write" | "readwrite";
  reason: string;
}

/** Files outside lib/brokerHub/ allowed to touch named tables, and why. */
export const ALLOWLIST: Readonly<Record<string, AllowEntry>> = {
  "routes/brokerHealth.ts": {
    tables: ["broker_health_state", "broker_health_logs"],
    access: "write",
    reason: "writer: the health monitor creates the singleton, persists each evaluation and applies operator toggles",
  },
  "lib/brokerReadOnly/service.ts": {
    tables: ["broker_readonly_snapshots", "broker_readonly_logs"],
    access: "write",
    reason: "writer: the Build KK read-only connector redacts and persists its snapshots and diagnostics",
  },
  "lib/live/masterBridgePool.ts": {
    tables: ["arx_master_bridge_pool"],
    access: "readwrite",
    reason: "writer: recomputes the shared-master pool projection from mt5_connection on every heartbeat; live dispatch reads it here (LIVE execution domain)",
  },
  "routes/adminAllocations.ts": {
    tables: ["arx_master_bridge_pool"],
    access: "readwrite",
    reason: "admin writer: shared-live pause/resume flag and over-allocation count on the pool row",
  },
  "lib/bridgeV2/ingest.ts": {
    tables: ["bridge_v2_stream_state"],
    access: "readwrite",
    reason: "writer: Bridge v2 ingest advances per-stream sequence and integrity counters",
  },
  "lib/bridgeV2/status.ts": {
    tables: ["bridge_v2_stream_state"],
    access: "readwrite",
    reason: "Bridge v2 status derivation: the one reader that turns stream rows into freshness",
  },
  "routes/bridgeV2.ts": {
    tables: ["bridge_v2_stream_state"],
    access: "readwrite",
    reason: "admin integrity trace lists raw stream counters (operator only)",
  },
};

function stripComments(src: string): string {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  return noBlock.split("\n").map((l) => (/^\s*\/\//.test(l) ? "" : l.replace(/\s\/\/.*$/, ""))).join("\n");
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Tables a file touches, with the 1-based line of each hit and whether that line reads. */
export function scanForBrokerStateTables(src: string, tables: readonly StateTable[] = STATE_TABLES): Array<{ line: number; table: string; reads: boolean }> {
  const out: Array<{ line: number; table: string; reads: boolean }> = [];
  const pats = tables.map((t) => ({
    table: t.sql,
    any: new RegExp(`\\b${esc(t.drizzle)}\\b|\\b(from|join|update|into)\\s+"?${esc(t.sql)}"?(?![_\\w])`, "i"),
    read: new RegExp(`\\.\\s*(from|\\w*[jJ]oin)\\(\\s*${esc(t.drizzle)}\\b|\\b(from|join)\\s+"?${esc(t.sql)}"?(?![_\\w])`, "i"),
  }));
  stripComments(src).split("\n").forEach((line, i) => {
    for (const p of pats) if (p.any.test(line)) out.push({ line: i + 1, table: p.table, reads: p.read.test(line) });
  });
  return out;
}

/** Violations for one file (key relative to api-server/src), and whether its allowlist entry was used. */
export function scanFile(key: string, src: string): { violations: string[]; allowUsed: boolean } {
  if (key.startsWith(HUB_DIR)) return { violations: [], allowUsed: false };
  const allow = ALLOWLIST[key];
  const violations: string[] = [];
  let allowUsed = false;
  for (const hit of scanForBrokerStateTables(src)) {
    const owner = STATE_TABLES.find((t) => t.sql === hit.table)!.owner;
    if (allow?.tables.includes(hit.table)) {
      allowUsed = true;
      if (allow.access === "write" && hit.reads) violations.push(`${hit.line}: ${hit.table} writer reads the table directly; read it back through ${owner}`);
      continue;
    }
    violations.push(`${hit.line}: direct ${hit.table} access; read it through ${owner}`);
  }
  return { violations, allowUsed };
}

export function checkSingleBrokerStateSource(): CheckResult {
  const violations: string[] = [];
  for (const owner of new Set(STATE_TABLES.map((t) => t.owner))) {
    if (!existsSync(join(API_SRC, owner))) violations.push(`artifacts/api-server/src/${owner} missing (owner)`);
  }
  for (const d of DELEGATED) {
    if (!existsSync(join(ROOT, d.guard))) violations.push(`${d.sql}: guard ${d.guard} missing`);
  }
  const used = new Set<string>();
  let scanned = 0;
  for (const file of walk(API_SRC, { skip: (p) => p.includes("__qa__") || p.endsWith(".test.ts") })) {
    const key = file.slice(API_SRC.length + 1);
    scanned++;
    const r = scanFile(key, readFileSync(file, "utf8"));
    if (r.allowUsed) used.add(key);
    for (const v of r.violations) violations.push(`${rel(file)}:${v}`);
  }
  for (const key of Object.keys(ALLOWLIST)) {
    if (!used.has(key)) violations.push(`stale allowlist entry artifacts/api-server/src/${key}: it no longer touches ${ALLOWLIST[key]!.tables.join(", ")}; remove it`);
  }
  return {
    name: "single-broker-state-source",
    ok: violations.length === 0,
    violations,
    notes: [
      `${scanned} files scanned; ${STATE_TABLES.length} broker state tables, ${Object.keys(ALLOWLIST).length} allowlisted files outside ${HUB_DIR}`,
      `delegated: ${DELEGATED.map((d) => d.sql).join(", ")}`,
    ],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = checkSingleBrokerStateSource();
  reportResult(r);
  process.exit(r.ok ? 0 : 1);
}

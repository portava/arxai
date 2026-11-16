// ── Bridge v2 truth/safety guard (Task #371) ────────────────────────────────
//
// The Bridge v2 ingest path is broker-truth TELEMETRY only. It must never be a
// second execution path. This guard statically locks that contract:
//
//   1. The ingest service never mutates execution/position state (no INSERT/
//      UPDATE/DELETE on arx_live_commands / arx_live_positions / mt5_commands).
//   2. The ingest service never imports the live command pipeline / instant
//      trade router (no execution call-graph reachable from ingest).
//   3. The EA ingest route is gated by `bridgeAuthPerUserOnly` (per-user token).
//   4. The ingest route is on the global-gate public allowlist (so the per-user
//      token check can run) — and ONLY the ingest route, never an admin route.
//   5. The domain contract stays pure: no DB/HTTP imports under lib/domain/bridge-v2.

import { read, rel, ROOT, type CheckResult } from "./_lib.js";
import { join } from "node:path";

function readIfExists(p: string): string {
  try { return read(p); } catch { return ""; }
}

export function checkBridgeV2Truth(): CheckResult {
  const violations: string[] = [];

  const ingestPath = join(ROOT, "artifacts/api-server/src/lib/bridgeV2/ingest.ts");
  const ingest = readIfExists(ingestPath);
  const routePath = join(ROOT, "artifacts/api-server/src/routes/bridgeV2.ts");
  const route = readIfExists(routePath);
  const gatePath = join(ROOT, "artifacts/api-server/src/lib/auth/globalGate.ts");
  const gate = readIfExists(gatePath);
  const egressPath = join(ROOT, "artifacts/api-server/src/lib/bridgeV2/egress.ts");
  const egress = readIfExists(egressPath);

  if (!ingest) violations.push(`${rel(ingestPath)}: ingest service missing`);
  if (!route) violations.push(`${rel(routePath)}: ingest route missing`);

  // 1. No execution/position mutation from the ingest service. The only tables
  //    ingest may write are its own truth/telemetry tables.
  const forbiddenTables = ["arxLiveCommandsTable", "arxLivePositionsTable", "mt5CommandsTable", "mt5DemoCommandsTable"];
  for (const t of forbiddenTables) {
    if (ingest.includes(t)) {
      violations.push(`ingest.ts: references execution table ${t} — ingest must be telemetry-only, never a 2nd execution path`);
    }
  }

  // 2. No execution pipeline / router imports in ingest.
  const forbiddenImports = [
    "liveCommandPipeline",
    "instantTrade",
    "executeInstantTrade",
    "placeLiveOrder",
    "dispatchLive",
  ];
  for (const imp of forbiddenImports) {
    if (ingest.includes(imp)) {
      violations.push(`ingest.ts: references execution path "${imp}" — ingest must not reach the live dispatch pipeline`);
    }
  }

  // 2b. The egress (server→EA) service MAY read arx_live_commands to project the
  //     whitelisted-command channel, but it must stay a PURE READ: never INSERT/
  //     UPDATE/DELETE any execution/position table, and never reach the live
  //     dispatch pipeline. This keeps the command channel a projection of
  //     already-16-gated rows — never a second execution path.
  if (egress) {
    const mutationPatterns = [
      /\.insert\s*\(\s*arxLiveCommandsTable/,
      /\.update\s*\(\s*arxLiveCommandsTable/,
      /\.delete\s*\(\s*arxLiveCommandsTable/,
      /\.insert\s*\(\s*arxLivePositionsTable/,
      /\.update\s*\(\s*arxLivePositionsTable/,
      /\.delete\s*\(\s*arxLivePositionsTable/,
      /\.insert\s*\(\s*mt5CommandsTable/,
      /\.update\s*\(\s*mt5CommandsTable/,
      /\.delete\s*\(\s*mt5CommandsTable/,
    ];
    for (const re of mutationPatterns) {
      if (re.test(egress)) {
        violations.push(`egress.ts: mutates an execution/position table (${re.source}) — the command channel must be a PURE read-projection, never an execution path`);
      }
    }
    for (const imp of forbiddenImports) {
      if (egress.includes(imp)) {
        violations.push(`egress.ts: references execution path "${imp}" — egress must not reach the live dispatch pipeline`);
      }
    }
  }

  // 3. EA route is gated by per-user bridge auth.
  if (route && !/bridgeAuthPerUserOnly/.test(route)) {
    violations.push(`bridgeV2.ts: ingest route is not gated by bridgeAuthPerUserOnly (per-user bridge token required)`);
  }
  // The server-wide MT5_BRIDGE_TOKEN must never be honored here.
  if (route && /MT5_BRIDGE_TOKEN/.test(route)) {
    violations.push(`bridgeV2.ts: references MT5_BRIDGE_TOKEN — only per-user tokens are allowed`);
  }

  // 3b. The two EA-facing egress GETs (config + commands) must each be gated by
  //     bridgeAuthPerUserOnly AND present on the public allowlist — otherwise the
  //     per-user token check can never run (a session-gated EA endpoint is broken
  //     for the EA, and an un-gated EA endpoint leaks per-user config/commands).
  const eaEgressPaths = ["/bridge/v2/config", "/bridge/v2/commands"];
  for (const p of eaEgressPaths) {
    const esc = p.replace(/\//g, "\\/");
    const gatedRe = new RegExp(`router\\.(get|post)\\(\\s*["']${esc}["']\\s*,\\s*bridgeAuthPerUserOnly`);
    if (route && !gatedRe.test(route)) {
      violations.push(`bridgeV2.ts: ${p} is not registered with bridgeAuthPerUserOnly as its first guard`);
    }
    if (gate && !new RegExp(esc).test(gate)) {
      violations.push(`globalGate.ts: ${p} missing from public allowlist (EA per-user token check can never run)`);
    }
  }

  // 4. Public allowlist contains the ingest path but NOT any admin trace path.
  if (gate && !/\/bridge\/v2\/ingest/.test(gate)) {
    violations.push(`globalGate.ts: /bridge/v2/ingest missing from public allowlist (EA token check can never run)`);
  }
  if (gate && /\/admin\/bridge-v2/.test(gate)) {
    violations.push(`globalGate.ts: an /admin/bridge-v2 path is on the public allowlist — admin trace must stay session-gated`);
  }

  // 5. Domain contract purity — no DB/HTTP imports under bridge-v2.
  for (const f of ["messageContract.ts", "lifecycle.ts", "sequenceTracking.ts", "index.ts"]) {
    const src = readIfExists(join(ROOT, "lib/domain/src/bridge-v2", f));
    if (/@workspace\/db|drizzle-orm|express|node:http|fetch\(/.test(src)) {
      violations.push(`lib/domain/src/bridge-v2/${f}: contains an IO import — bridge-v2 domain must stay pure`);
    }
  }

  return {
    name: "bridge-v2-truth",
    ok: violations.length === 0,
    violations,
  };
}

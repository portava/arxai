// Task #31 — Pure unit test for the bridge watchdog classifier.
//
// Asserts classifyBridge() correctly maps connection + heartbeat state onto
// liveness (fresh/stale/offline/revoked), the EA-condition flags, and the
// dedupe alert decision. Pure logic — no DB, no network.
//
// Run: pnpm --filter @workspace/scripts run test:bridge-watchdog

import {
  classifyBridge,
  type BridgeWatchdogInput,
} from "../../artifacts/api-server/src/lib/live/bridgeWatchdog.js";
import {
  MT5_HEARTBEAT_FRESH_BELOW_SECONDS,
  MT5_HEARTBEAT_OFFLINE_AT_SECONDS,
} from "../../lib/domain/src/broker-health/heartbeatPolicy.js";

const NOW = new Date("2026-05-29T12:00:00.000Z");
function hbAgo(seconds: number): Date {
  return new Date(NOW.getTime() - seconds * 1000);
}

function baseInput(overrides: Partial<BridgeWatchdogInput> = {}): BridgeWatchdogInput {
  return {
    connectionId: 1,
    userId: 100,
    connectionName: "Test Bridge",
    tokenRevokedAt: null,
    lastHeartbeat: hbAgo(5),
    accountType: "live",
    eaVersion: "1.28",
    eaInputs: {
      readOnlyMode: false,
      enableLiveExecution: true,
      terminalConnected: true,
      algoTradingAllowed: true,
    },
    siblingFreshCount: 0,
    now: NOW,
    ...overrides,
  };
}

let pass = 0, fail = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { pass++; return; }
  fail++; failures.push(`[${name}] ${detail}`);
}

// ── liveness boundaries ─────────────────────────────────────────────────────
{
  const v = classifyBridge(baseInput({ lastHeartbeat: hbAgo(5) }));
  check("fresh at 5s", v.liveness === "fresh", `got ${v.liveness}`);
  check("fresh no alert", v.shouldAlert === false, `got ${v.shouldAlert}`);
  check("fresh severity info", v.alertSeverity === "info", v.alertSeverity);
}
// Shared heartbeat policy (owner decision 17): < 15 s fresh, < 60 s "stale"
// (degraded), >= 60 s offline. Before the decision the watchdog was
// inclusive (15 s fresh, 60 s stale) on floored seconds.
{
  const v = classifyBridge(baseInput({ lastHeartbeat: hbAgo(MT5_HEARTBEAT_FRESH_BELOW_SECONDS - 0.001) }));
  check("fresh at 14.999s", v.liveness === "fresh", `got ${v.liveness}`);
}
{
  const v = classifyBridge(baseInput({ lastHeartbeat: hbAgo(MT5_HEARTBEAT_FRESH_BELOW_SECONDS) }));
  check("stale at exactly 15s (was fresh)", v.liveness === "stale", `got ${v.liveness}`);
  check("stale alerts", v.shouldAlert === true, `got ${v.shouldAlert}`);
  check("stale severity warning", v.alertSeverity === "warning", v.alertSeverity);
}
{
  const v = classifyBridge(baseInput({ lastHeartbeat: hbAgo(MT5_HEARTBEAT_OFFLINE_AT_SECONDS - 0.001) }));
  check("stale at 59.999s", v.liveness === "stale", `got ${v.liveness}`);
}
{
  const v = classifyBridge(baseInput({ lastHeartbeat: hbAgo(MT5_HEARTBEAT_OFFLINE_AT_SECONDS) }));
  check("offline at exactly 60s (was stale)", v.liveness === "offline", `got ${v.liveness}`);
  check("offline alerts", v.shouldAlert === true, `got ${v.shouldAlert}`);
  check("offline severity danger", v.alertSeverity === "danger", v.alertSeverity);
}
{
  const v = classifyBridge(baseInput({ lastHeartbeat: hbAgo(-5) }));
  check("future-dated heartbeat is offline (unknown, never fresh)", v.liveness === "offline", `got ${v.liveness}`);
}
{
  const v = classifyBridge(baseInput({ lastHeartbeat: new Date(Number.NaN) }));
  check("invalid heartbeat is offline", v.liveness === "offline", `got ${v.liveness}`);
}
{
  const v = classifyBridge(baseInput({ lastHeartbeat: null }));
  check("never-heartbeat is offline", v.liveness === "offline", `got ${v.liveness}`);
  check("never-heartbeat age null", v.heartbeatAgeSeconds === null, `${v.heartbeatAgeSeconds}`);
}

// ── revoked dominates everything ────────────────────────────────────────────
{
  const v = classifyBridge(baseInput({ tokenRevokedAt: hbAgo(1), lastHeartbeat: hbAgo(1) }));
  check("revoked liveness", v.liveness === "revoked", v.liveness);
  check("revoked never alerts", v.shouldAlert === false, `${v.shouldAlert}`);
  check("revoked no conditions", v.conditions.length === 0, JSON.stringify(v.conditions));
}

// ── EA conditions only when not offline ─────────────────────────────────────
{
  const v = classifyBridge(baseInput({
    lastHeartbeat: hbAgo(5),
    eaInputs: { readOnlyMode: true, enableLiveExecution: false, terminalConnected: false, algoTradingAllowed: false },
  }));
  check("disconnected condition", v.conditions.includes("disconnected"), JSON.stringify(v.conditions));
  check("read_only condition", v.conditions.includes("read_only"), JSON.stringify(v.conditions));
  check("algo_off condition", v.conditions.includes("algo_off"), JSON.stringify(v.conditions));
  check("live_disabled condition", v.conditions.includes("live_disabled"), JSON.stringify(v.conditions));
}
{
  // Offline suppresses stale EA flags (last-known values are unreliable).
  const v = classifyBridge(baseInput({
    lastHeartbeat: hbAgo(MT5_HEARTBEAT_OFFLINE_AT_SECONDS + 100),
    eaInputs: { readOnlyMode: true, enableLiveExecution: false, terminalConnected: false, algoTradingAllowed: false },
  }));
  check("offline suppresses EA conditions",
    !v.conditions.includes("disconnected") && !v.conditions.includes("read_only"),
    JSON.stringify(v.conditions));
}

// ── leader conflict survives even when offline ──────────────────────────────
{
  const v = classifyBridge(baseInput({ siblingFreshCount: 1 }));
  check("leader_conflict on sibling", v.conditions.includes("leader_conflict"), JSON.stringify(v.conditions));
}
{
  const v = classifyBridge(baseInput({ siblingFreshCount: 0 }));
  check("no leader_conflict when alone", !v.conditions.includes("leader_conflict"), JSON.stringify(v.conditions));
}

console.log(`bridge-watchdog classifier: ${pass}/${pass + fail} PASS`);
if (failures.length) {
  for (const f of failures) console.log("  FAIL " + f);
  process.exit(1);
}
process.exit(0);

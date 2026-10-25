// Owner decision 17 — the ONE shared MT5 connection heartbeat policy.
// Exact-boundary proofs for the pure policy and for the pure evaluators moved
// onto it. Pure: no DB, no network.
import assert from "node:assert/strict";
import test from "node:test";
import * as policy from "@workspace/domain/broker-health/heartbeatPolicy";
import { evaluateBrokerHealth } from "@workspace/domain/broker-health";
import { evaluateBrokerHealth as evaluateLegacyBrokerStatus } from "@workspace/domain/broker";
import { computeFreshness, type AaciSharedTruthSnapshot } from "@workspace/domain/aaci";
import * as server from "../freshness.js";

const {
  classifyHeartbeatAgeMs,
  classifyHeartbeatAgeSeconds,
  classifyHeartbeatAt,
  heartbeatAgeMsFrom,
  heartbeatAllowsExecution,
  heartbeatIsOnline,
} = policy;

const NOW = Date.parse("2026-10-25T12:00:00.000Z");

test("owner bounds: < 15 s fresh, 15–60 s degraded, >= 60 s offline", () => {
  assert.equal(policy.MT5_HEARTBEAT_FRESH_BELOW_MS, 15_000);
  assert.equal(policy.MT5_HEARTBEAT_OFFLINE_AT_MS, 60_000);
  assert.equal(classifyHeartbeatAgeMs(0), "fresh");
  assert.equal(classifyHeartbeatAgeMs(14_999), "fresh");
  assert.equal(classifyHeartbeatAgeMs(14_999.999), "fresh");
  assert.equal(classifyHeartbeatAgeMs(15_000), "degraded");
  assert.equal(classifyHeartbeatAgeMs(59_999), "degraded");
  assert.equal(classifyHeartbeatAgeMs(59_999.999), "degraded");
  assert.equal(classifyHeartbeatAgeMs(60_000), "offline");
  assert.equal(classifyHeartbeatAgeMs(10 * 60_000), "offline");
});

test("missing / invalid / negative / non-finite observations are unknown and never execution-ready", () => {
  for (const bad of [null, undefined, Number.NaN, -1, -0.001, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const f = classifyHeartbeatAgeMs(bad as number | null | undefined);
    assert.equal(f, "unknown", String(bad));
    assert.equal(heartbeatAllowsExecution(f), false, String(bad));
    assert.equal(heartbeatIsOnline(f), false, String(bad));
    assert.equal(classifyHeartbeatAgeSeconds(bad as number | null | undefined), "unknown", String(bad));
  }
});

test("seconds: exact for fractional and floored ages", () => {
  assert.equal(classifyHeartbeatAgeSeconds(14.999), "fresh");
  assert.equal(classifyHeartbeatAgeSeconds(15), "degraded");
  assert.equal(classifyHeartbeatAgeSeconds(59.999), "degraded");
  assert.equal(classifyHeartbeatAgeSeconds(60), "offline");
  // floor(x) < 15 ⇔ x < 15, so a floored age classifies like the exact age.
  for (const ms of [14_999, 15_000, 15_999, 59_999, 60_000]) {
    assert.equal(classifyHeartbeatAgeSeconds(Math.floor(ms / 1000)), classifyHeartbeatAgeMs(ms), String(ms));
  }
});

test("only fresh is execution-ready; fresh and degraded are online", () => {
  assert.deepEqual(policy.HEARTBEAT_FRESHNESS_VALUES, ["fresh", "degraded", "offline", "unknown"]);
  assert.equal(heartbeatAllowsExecution("fresh"), true);
  for (const f of ["degraded", "offline", "unknown"] as const) assert.equal(heartbeatAllowsExecution(f), false);
  assert.equal(heartbeatIsOnline("fresh"), true);
  assert.equal(heartbeatIsOnline("degraded"), true);
  assert.equal(heartbeatIsOnline("offline"), false);
  assert.equal(heartbeatIsOnline("unknown"), false);
  assert.equal(policy.isHeartbeatAgeMsFresh(14_999), true);
  assert.equal(policy.isHeartbeatAgeMsFresh(15_000), false);
  assert.equal(policy.isHeartbeatAgeSecondsOnline(59.999), true);
  assert.equal(policy.isHeartbeatAgeSecondsOnline(60), false);
});

test("timestamps: Date, ISO string, epoch ms; unparseable or future-dated → unknown", () => {
  assert.equal(classifyHeartbeatAt(new Date(NOW - 14_999), NOW), "fresh");
  assert.equal(classifyHeartbeatAt(new Date(NOW - 15_000).toISOString(), NOW), "degraded");
  assert.equal(classifyHeartbeatAt(NOW - 60_000, NOW), "offline");
  assert.equal(classifyHeartbeatAt(null, NOW), "unknown");
  assert.equal(classifyHeartbeatAt("not a date", NOW), "unknown");
  assert.equal(classifyHeartbeatAt(new Date(Number.NaN), NOW), "unknown");
  assert.equal(classifyHeartbeatAt(new Date(NOW + 1), NOW), "unknown");
  assert.equal(heartbeatAgeMsFrom(null, NOW), null);
  assert.equal(heartbeatAgeMsFrom(new Date(NOW - 5), NOW), 5);
  assert.equal(heartbeatAgeMsFrom(new Date(NOW), Number.NaN), null);
});

test("the server authority re-exports the same policy (one implementation)", () => {
  assert.equal(server.classifyHeartbeatAgeMs, classifyHeartbeatAgeMs);
  assert.equal(server.classifyHeartbeatAt, classifyHeartbeatAt);
  assert.equal(server.heartbeatAllowsExecution, heartbeatAllowsExecution);
  assert.equal(server.MT5_HEARTBEAT_FRESH_BELOW_MS, 15_000);
  // Distinct concepts keep their own, separately named values.
  assert.equal(server.MT5_ACCOUNT_SNAPSHOT_FRESH_MS, 60_000);
  assert.equal(server.ACCOUNT_SNAPSHOT_FRESH_MS, 30_000);
  assert.equal(server.MT5_POSITIONS_SNAPSHOT_FRESH_SECONDS, 60);
  assert.equal(server.FUNDBOOK_MIRROR_FRESH_MS, 15_000);
  assert.equal(server.FUNDBOOK_MIRROR_DELAYED_MS, 60_000);
  assert.equal(server.BRIDGE_V2_STREAM_STALE_MS, 120_000);
  assert.equal(server.BROKER_HEALTH_VERDICT_STALE_MS, 120_000);
});

// ── lib/domain broker-health evaluator (was degraded > 30 s) ────────────────
function verdictAt(ageMs: number | null) {
  return evaluateBrokerHealth({
    nowMs: NOW,
    lastHeartbeatAtMs: ageMs == null ? null : NOW - ageMs,
    lastSyncAtMs: NOW,
    executionEnabled: true,
    maintenanceMode: false,
    reconnectAttempts: 0,
  });
}

test("broker-health evaluator: heartbeat bands from the shared policy", () => {
  assert.equal(verdictAt(14_999).status, "CONNECTED");
  assert.equal(verdictAt(15_000).status, "DEGRADED"); // was CONNECTED up to 30 s
  assert.equal(verdictAt(29_999).status, "DEGRADED");
  assert.equal(verdictAt(59_999).status, "DEGRADED");
  assert.equal(verdictAt(60_000).status, "DISCONNECTED");
  assert.equal(verdictAt(null).status, "DISCONNECTED");
  // Future-dated heartbeat: unknown → DISCONNECTED (was clamped to age 0 → CONNECTED).
  const future = verdictAt(-5_000);
  assert.equal(future.status, "DISCONNECTED");
  assert.equal(future.latencyMs, null);
  assert.ok(future.blockers.length > 0);
  // Operator maintenance keeps the highest priority.
  assert.equal(
    evaluateBrokerHealth({ nowMs: NOW, lastHeartbeatAtMs: NOW - 1_000, lastSyncAtMs: NOW, executionEnabled: true, maintenanceMode: true, reconnectAttempts: 0 }).status,
    "MAINTENANCE_MODE",
  );
});

test("legacy broker-status engine defaults follow the policy", () => {
  const at = (ageMs: number) => evaluateLegacyBrokerStatus(
    { status: "CONNECTED", mode: "DEMO", lastHeartbeatMs: NOW - ageMs } as Parameters<typeof evaluateLegacyBrokerStatus>[0],
    new Date(NOW),
  );
  assert.equal(at(14_999).isHealthy, true);
  assert.equal(at(15_000).status, "DELAYED");
  assert.equal(at(59_999).status, "DELAYED");
  assert.equal(at(60_000).status, "ERROR");
  assert.equal(at(-1_000).status, "DISCONNECTED");
  assert.equal(at(-1_000).isHealthy, false);
});

test("AACI bridgeHeartbeat source is stale once not fresh (>= 15 s) or unknown", () => {
  const snap = (heartbeatAgeMs: number | undefined) =>
    ({ bridge: { heartbeatAgeMs }, account: {}, positions: {} }) as unknown as AaciSharedTruthSnapshot;
  const rec = (age: number | undefined) =>
    computeFreshness(snap(age), NOW).records.find((r) => r.source === "bridgeHeartbeat")!;
  assert.equal(rec(14_999).stale, false);
  assert.equal(rec(15_000).stale, true); // was fresh at exactly 15 s (<=)
  assert.equal(computeFreshness(snap(15_000), NOW).criticalStale, true);
  assert.equal(rec(-1).stale, true);
  assert.equal(rec(undefined).stale, true);
});

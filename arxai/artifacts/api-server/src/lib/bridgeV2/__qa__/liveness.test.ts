// Owner decision 18 — Bridge v2 reports the comparable heartbeat fact in the
// shared vocabulary, keeps stream-specific health separately named, keeps
// the legacy fields unchanged, and never implies execution readiness.
// Pure: no DB, no network.
import assert from "node:assert/strict";
import test from "node:test";
import { bridgeV2StreamHealth, deriveBridgeV2Liveness } from "../liveness.js";

test("heartbeatFreshness uses the shared policy at the exact boundaries", () => {
  assert.equal(deriveBridgeV2Liveness(14_999).heartbeatFreshness, "fresh");
  assert.equal(deriveBridgeV2Liveness(15_000).heartbeatFreshness, "degraded");
  assert.equal(deriveBridgeV2Liveness(59_999).heartbeatFreshness, "degraded");
  assert.equal(deriveBridgeV2Liveness(60_000).heartbeatFreshness, "offline");
  assert.equal(deriveBridgeV2Liveness(null).heartbeatFreshness, "unknown");
  assert.equal(deriveBridgeV2Liveness(Number.NaN).heartbeatFreshness, "unknown");
  assert.equal(deriveBridgeV2Liveness(-1).heartbeatFreshness, "unknown");
});

test("stream health keeps its own separately named bands (legacy values, inclusive)", () => {
  assert.equal(bridgeV2StreamHealth(null), "UNKNOWN");
  assert.equal(bridgeV2StreamHealth(15_000), "LIVE");
  assert.equal(bridgeV2StreamHealth(15_001), "STALE");
  assert.equal(bridgeV2StreamHealth(120_000), "STALE");
  assert.equal(bridgeV2StreamHealth(120_001), "OFFLINE");
});

test("the two vocabularies are reported side by side and can differ", () => {
  // 15 s: the stream is still LIVE (legacy connected) but the heartbeat is degraded.
  const at15 = deriveBridgeV2Liveness(15_000);
  assert.equal(at15.streamHealth, "LIVE");
  assert.equal(at15.connected, true);
  assert.equal(at15.heartbeatFreshness, "degraded");
  // 90 s: stream STALE, heartbeat offline.
  const at90 = deriveBridgeV2Liveness(90_000);
  assert.equal(at90.streamHealth, "STALE");
  assert.equal(at90.connected, false);
  assert.equal(at90.heartbeatFreshness, "offline");
});

test("legacy connected is unchanged: stream LIVE (age <= 15 s)", () => {
  assert.equal(deriveBridgeV2Liveness(0).connected, true);
  assert.equal(deriveBridgeV2Liveness(15_000).connected, true);
  assert.equal(deriveBridgeV2Liveness(15_001).connected, false);
  assert.equal(deriveBridgeV2Liveness(null).connected, false);
});

test("a healthy stream never implies execution readiness", () => {
  for (const age of [0, 1_000, 14_999, 15_000, 60_000, null, -5]) {
    const l = deriveBridgeV2Liveness(age);
    assert.equal(l.streamImpliesExecutionReady, false, String(age));
  }
  const best = deriveBridgeV2Liveness(0);
  assert.equal(best.streamHealth, "LIVE");
  assert.equal(best.heartbeatFreshness, "fresh");
  assert.equal(best.streamImpliesExecutionReady, false);
  // The liveness facts carry no field that could be read as a go-ahead.
  assert.deepEqual(Object.keys(best).sort(), ["connected", "heartbeatFreshness", "streamHealth", "streamImpliesExecutionReady"]);
});

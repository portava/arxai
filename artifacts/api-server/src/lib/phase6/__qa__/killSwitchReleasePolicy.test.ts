// Phase 6 - kill-switch RELEASE policy.
//
// The release doorway exists so Tier 1 guided demo certification is reachable
// without standing up MT5 shared-live posture. These tests pin the wall the
// doorway sits in: release is permitted ONLY while every live control is off,
// each hot control refuses independently, all hot controls are reported
// together, and an unknown posture reads as HOT, never cold.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  killSwitchReleaseViolations,
  postureFromSettingsRow,
  type KillSwitchReleasePosture,
} from "../killSwitchReleasePolicy.js";

const COLD: KillSwitchReleasePosture = {
  platformMode: "OFF",
  liveEnabled: false,
  sharedLiveTradingEnabled: false,
  masterBridgeLiveEnabled: false,
  liveBrokerExecutionArmed: false,
  liveBrokerExecutionEnvEnabled: false,
};

test("fully cold posture permits release (no violations)", () => {
  assert.deepEqual(killSwitchReleaseViolations(COLD), []);
});

test("every non-LIVE platform mode is acceptable for release", () => {
  for (const mode of ["OFF", "UNKNOWN", "DEMO", "SIMULATED"]) {
    assert.deepEqual(
      killSwitchReleaseViolations({ ...COLD, platformMode: mode }),
      [],
      `platformMode=${mode} should not block release`,
    );
  }
});

test("each hot control refuses release on its own", () => {
  const hots: Array<[Partial<KillSwitchReleasePosture>, string]> = [
    [{ platformMode: "LIVE" }, "platformMode is LIVE"],
    [{ liveEnabled: true }, "liveEnabled is true"],
    [{ sharedLiveTradingEnabled: true }, "sharedLiveTradingEnabled is true"],
    [{ masterBridgeLiveEnabled: true }, "masterBridgeLiveEnabled is true"],
    [{ liveBrokerExecutionArmed: true }, "liveBrokerExecutionArmed is true"],
    [{ liveBrokerExecutionEnvEnabled: true }, "ARX_LIVE_BROKER_EXECUTION_ENABLED is enabled server-side"],
  ];
  for (const [patch, expected] of hots) {
    const v = killSwitchReleaseViolations({ ...COLD, ...patch });
    assert.deepEqual(v, [expected]);
  }
});

test("all hot controls are reported together, not first-only", () => {
  const v = killSwitchReleaseViolations({
    platformMode: "LIVE",
    liveEnabled: true,
    sharedLiveTradingEnabled: true,
    masterBridgeLiveEnabled: true,
    liveBrokerExecutionArmed: true,
    liveBrokerExecutionEnvEnabled: true,
  });
  assert.equal(v.length, 6);
});

test("a missing settings row maps to the schema-default cold posture", () => {
  const p = postureFromSettingsRow(null, false);
  assert.deepEqual(p, COLD);
  assert.deepEqual(killSwitchReleaseViolations(p), []);
});

test("the env switch survives a missing row — env hot means posture hot", () => {
  const p = postureFromSettingsRow(undefined, true);
  assert.equal(p.liveBrokerExecutionEnvEnabled, true);
  assert.deepEqual(killSwitchReleaseViolations(p), [
    "ARX_LIVE_BROKER_EXECUTION_ENABLED is enabled server-side",
  ]);
});

test("null/undefined fields on an EXISTING row resolve HOT, not cold", () => {
  // A row we cannot prove cold is not cold: every unknown flag reads as
  // engaged and unknown platformMode reads as LIVE.
  const p = postureFromSettingsRow({}, false);
  assert.equal(p.platformMode, "LIVE");
  assert.equal(p.liveEnabled, true);
  assert.equal(p.sharedLiveTradingEnabled, true);
  assert.equal(p.masterBridgeLiveEnabled, true);
  assert.equal(p.liveBrokerExecutionArmed, true);
  assert.equal(killSwitchReleaseViolations(p).length, 5);
});

test("an explicit cold row round-trips to a permitted release", () => {
  const p = postureFromSettingsRow(
    {
      platformMode: "OFF",
      liveEnabled: false,
      sharedLiveTradingEnabled: false,
      masterBridgeLiveEnabled: false,
      liveBrokerExecutionArmed: false,
    },
    false,
  );
  assert.deepEqual(killSwitchReleaseViolations(p), []);
});

test("a live row is hot regardless of the env switch being off", () => {
  const p = postureFromSettingsRow(
    {
      platformMode: "LIVE",
      liveEnabled: true,
      sharedLiveTradingEnabled: false,
      masterBridgeLiveEnabled: false,
      liveBrokerExecutionArmed: false,
    },
    false,
  );
  assert.deepEqual(killSwitchReleaseViolations(p), [
    "platformMode is LIVE",
    "liveEnabled is true",
  ]);
});

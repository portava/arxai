// Truth regression: the Control Tower says why a mode is not offered.
//
// Before: /system/status always sent reasons: [] and blockers: [], so the
// Control Tower showed "Blocked by gate" with no reason, and a refused
// change's blockers (409) reached the operator nowhere. modeBlockers names,
// for each mode, the condition that keeps it out of allowedModes, in the
// words setOperationalMode uses when it refuses.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit src/lib/__qa__/safetyCoreModeBlockers.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { globalState as gs } from "@workspace/domain";
import { computeAllowedModes, computeModeBlockers, ALL_OPERATIONAL_MODES } from "../safetyCore.js";

const STATES = gs.GlobalStateSchema.options as gs.GlobalState[];
const LINKS = ["OK", "DEGRADED", "DOWN"] as const;

test("a mode has blockers exactly when it is not in allowedModes", () => {
  for (const ks of [true, false]) {
    for (const state of STATES) {
      for (const link of LINKS) {
        const allowed = computeAllowedModes(ks, state, link);
        const blockers = computeModeBlockers(ks, state, link);
        for (const mode of ALL_OPERATIONAL_MODES) {
          assert.equal(
            blockers[mode].length === 0, allowed.includes(mode),
            `ks=${ks} state=${state} link=${link} mode=${mode}: blockers=${JSON.stringify(blockers[mode])} allowed=${allowed.join(",")}`,
          );
        }
      }
    }
  }
});

test("LIVE_TRADING with a degraded MT5 link names the link, as the refused change does", () => {
  const b = computeModeBlockers(false, "NORMAL", "DEGRADED");
  assert.deepEqual(b.LIVE_TRADING, ["LIVE_TRADING requires MT5 link OK; current=DEGRADED"]);
  assert.deepEqual(b.PAPER_TRADING, []);
});

test("an engaged kill switch blocks every mode but OBSERVE_ONLY, and says so", () => {
  const b = computeModeBlockers(true, "NORMAL", "OK");
  assert.deepEqual(b.OBSERVE_ONLY, []);
  for (const m of ["SUGGEST_ONLY", "PAPER_TRADING", "LIVE_TRADING"] as const) {
    assert.match(b[m][0] ?? "", /kill switch engaged/);
  }
});

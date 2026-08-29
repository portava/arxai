// Emergency-kill-switch dispatch pre-gate (global halt).
//
// Proves the gap the production-readiness audit confirmed can never reopen:
// POST /api/admin/trading/emergency-kill engages
// global_trading_settings.emergency_kill_switch, but the 23-gate evaluator's
// `globalLiveEnabled` input does NOT fold the kill switch in (getEnvelope
// computes it from platformMode + liveEnabled alone) — so before the pre-gate,
// a USER_OWNED_MT5 dispatch passed all 23 gates during a platform-wide halt.
//
// These are pure-unit proofs of `emergencyKillSwitchBlocksDispatch` (no DB, no
// network — the decision helper is extracted exactly so this contract can run
// offline), plus a source-order proof that dispatchLiveCommand consults the
// pre-gate BEFORE the 23-gate evaluator.
//
// The ONLY exemption the gate grants is the Task #743 Cluster D
// admin-emergency-close CLOSE marker — the same narrow, integrity-hashed
// relaxation gate #5 (per-user kill switch) grants — so an operator can still
// flatten exposure while the platform is halted. The lockstep test pins the
// exemption to `killSwitchCloseBypassApplies` so the two gates can never drift.
//
// Importing ../liveCommandPipeline.js transitively imports @workspace/db, whose
// module init throws when DATABASE_URL is unset. A dummy loopback URL satisfies
// the init; the pg Pool is lazy and NO query is ever issued by these tests.
//
// Run: node --import tsx --test --test-force-exit \
//   src/lib/live/__qa__/emergencyKillSwitchPreGate.test.ts

process.env.DATABASE_URL ??= "postgres://qa:qa@127.0.0.1:1/qa_offline_never_connects";

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { killSwitchCloseBypassApplies } from "../killSwitchBypass.js";

const {
  emergencyKillSwitchBlocksDispatch,
  EMERGENCY_KILL_SWITCH_BLOCK_REASON,
} = await import("../liveCommandPipeline.js");

const COMMAND_TYPES = [
  "PLACE_LIVE_MARKET_ORDER",
  "PLACE_LIVE_PENDING_ORDER",
  "CLOSE_LIVE_POSITION",
  "MODIFY_LIVE_SLTP",
] as const;

test("the block-reason literal is CI-pinned", () => {
  assert.equal(EMERGENCY_KILL_SWITCH_BLOCK_REASON, "LIVE_BLOCKED:EMERGENCY_KILL_SWITCH_ENGAGED");
});

test("engaged blocks EVERY command type without the Cluster D marker", () => {
  for (const commandType of COMMAND_TYPES) {
    assert.equal(
      emergencyKillSwitchBlocksDispatch({
        emergencyKillSwitch: true,
        commandType,
        hasKillSwitchCloseBypassMarker: false,
      }),
      true,
      `${commandType} must be refused while the emergency kill switch is engaged`,
    );
  }
});

test("disengaged (explicit false) blocks nothing, marker or not", () => {
  for (const commandType of COMMAND_TYPES) {
    for (const hasKillSwitchCloseBypassMarker of [false, true]) {
      assert.equal(
        emergencyKillSwitchBlocksDispatch({
          emergencyKillSwitch: false,
          commandType,
          hasKillSwitchCloseBypassMarker,
        }),
        false,
        `${commandType} must not be refused when the kill switch is explicitly disengaged`,
      );
    }
  }
});

test("FAIL-CLOSED: a missing/unreadable settings value counts as ENGAGED", () => {
  // Matches the column default (emergency_kill_switch NOT NULL DEFAULT true),
  // the FAIL_CLOSED safety envelope, and buildApprovedTraderLiveState's
  // `settingsRow?.emergencyKillSwitch !== false`.
  for (const missing of [null, undefined]) {
    assert.equal(
      emergencyKillSwitchBlocksDispatch({
        emergencyKillSwitch: missing,
        commandType: "PLACE_LIVE_MARKET_ORDER",
        hasKillSwitchCloseBypassMarker: false,
      }),
      true,
      "an unknown kill-switch state must refuse dispatch, never allow it",
    );
  }
});

test("the ONLY exemption is the CLOSE-only Cluster D marker", () => {
  // Stamped admin-emergency-close CLOSE passes so the operator can flatten
  // exposure during the halt...
  assert.equal(
    emergencyKillSwitchBlocksDispatch({
      emergencyKillSwitch: true,
      commandType: "CLOSE_LIVE_POSITION",
      hasKillSwitchCloseBypassMarker: true,
    }),
    false,
  );
  // ...but the marker NEVER exempts an entry or a modify (narrow-CLOSE-only).
  for (const commandType of ["PLACE_LIVE_MARKET_ORDER", "PLACE_LIVE_PENDING_ORDER", "MODIFY_LIVE_SLTP"]) {
    assert.equal(
      emergencyKillSwitchBlocksDispatch({
        emergencyKillSwitch: true,
        commandType,
        hasKillSwitchCloseBypassMarker: true,
      }),
      true,
      `a bypass marker on ${commandType} must not exempt it from the emergency kill switch`,
    );
  }
});

test("LOCKSTEP: the exemption is exactly the gate-#5 bypass predicate", () => {
  // The pre-gate's exemption must equal killSwitchCloseBypassApplies for every
  // command-type × marker combination — if either side is ever widened or
  // narrowed independently, this drift assertion goes red.
  for (const commandType of COMMAND_TYPES) {
    for (const hasBypassMarker of [false, true]) {
      assert.equal(
        emergencyKillSwitchBlocksDispatch({
          emergencyKillSwitch: true,
          commandType,
          hasKillSwitchCloseBypassMarker: hasBypassMarker,
        }),
        !killSwitchCloseBypassApplies({ commandType, hasBypassMarker }),
      );
    }
  }
});

test("dispatchLiveCommand consults the pre-gate BEFORE the 23-gate evaluator", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../liveCommandPipeline.ts", import.meta.url)),
    "utf8",
  );
  const dispatchStart = source.indexOf("export async function dispatchLiveCommand");
  assert.ok(dispatchStart > 0, "dispatchLiveCommand must exist in liveCommandPipeline.ts");
  const preGateAt = source.indexOf("emergencyKillSwitchBlocksDispatch({", dispatchStart);
  const evaluatorAt = source.indexOf("evaluateLivePhaseBDispatchGate({", dispatchStart);
  assert.ok(preGateAt > 0, "dispatchLiveCommand must call emergencyKillSwitchBlocksDispatch");
  assert.ok(evaluatorAt > 0, "dispatchLiveCommand must still run the 23-gate evaluator");
  assert.ok(
    preGateAt < evaluatorAt,
    "the emergency-kill-switch pre-gate must run BEFORE the 23-gate evaluator",
  );
});

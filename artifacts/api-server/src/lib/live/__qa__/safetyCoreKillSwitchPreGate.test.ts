// Safety-core kill-switch gate on the LIVE (MT5) command pipeline.
//
// The rank-1 audit finding this pins shut:
//
//   /emergency — "ENGAGE KILL SWITCH", the single safety item in every user's
//   nav — writes safety_core.kill_switch_engaged and tells the trader
//   "Forces SAFE_SHUTDOWN, blocks all execution" and "All trading will halt
//   immediately". Every real-money path runs through liveCommandPipeline, and
//   a grep of that file for safetyCore returned ONE COMMENT. Its gates read
//   arx_live_arming.kill_switch_engaged and
//   global_trading_settings.emergency_kill_switch — never safety_core.
//   guidedDispatchEntry.ts said it out loud: "the MT5 pipeline's own gates do
//   not read it". A trader in a panic pressed the advertised emergency stop,
//   read KILL SWITCH ENGAGED, and a one-click-armed dispatch could still reach
//   the broker seconds later.
//
// These are pure-unit proofs of `safetyCoreKillSwitchBlocksDispatch` (no DB, no
// network — the decision helper is extracted exactly so this contract can run
// offline), plus source-order proofs that BOTH the draft preflight and
// dispatchLiveCommand consult it, dispatch-side BEFORE the 18-gate evaluator.
//
// This adds NO new kill switch (Owner Ruling 4 forbids a 5th): it makes the
// EXISTING Phase 1 safety-core switch reach the pipeline the page claims it
// halts. The only exemption is the Owner Ruling 6 emergency-CLOSE bypass,
// pinned below to `killSwitchCloseBypassApplies` so the three gates that honour
// it can never drift apart.
//
// Importing ../liveCommandPipeline.js transitively imports @workspace/db, whose
// module init throws when DATABASE_URL is unset. A dummy loopback URL satisfies
// the init; the pg Pool is lazy and NO query is ever issued by these tests.
//
// Run: node --import tsx --test --test-force-exit \
//   src/lib/live/__qa__/safetyCoreKillSwitchPreGate.test.ts

process.env.DATABASE_URL ??= "postgres://qa:qa@127.0.0.1:1/qa_offline_never_connects";

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { killSwitchCloseBypassApplies } from "../killSwitchBypass.js";

const {
  safetyCoreKillSwitchBlocksDispatch,
  SAFETY_CORE_KILL_SWITCH_BLOCK_REASON,
} = await import("../liveCommandPipeline.js");

const COMMAND_TYPES = [
  "PLACE_LIVE_MARKET_ORDER",
  "PLACE_LIVE_PENDING_ORDER",
  "CLOSE_LIVE_POSITION",
  "MODIFY_LIVE_SLTP",
] as const;

const SOURCE = readFileSync(
  fileURLToPath(new URL("../liveCommandPipeline.ts", import.meta.url)),
  "utf8",
);

test("the block-reason literal is CI-pinned", () => {
  assert.equal(
    SAFETY_CORE_KILL_SWITCH_BLOCK_REASON,
    "LIVE_BLOCKED:SAFETY_CORE_KILL_SWITCH_ENGAGED",
  );
});

test("engaged blocks EVERY command type without the Cluster D marker", () => {
  for (const commandType of COMMAND_TYPES) {
    assert.equal(
      safetyCoreKillSwitchBlocksDispatch({
        safetyCoreKillSwitchEngaged: true,
        commandType,
        hasKillSwitchCloseBypassMarker: false,
      }),
      true,
      `${commandType} must be refused while the safety-core kill switch is engaged`,
    );
  }
});

test("disengaged (explicit false) blocks nothing, marker or not", () => {
  // safety_core.kill_switch_engaged is NOT NULL DEFAULT false, so an explicit
  // `false` is a REAL read of a disengaged switch — the platform is not halted
  // and this gate must not invent a halt.
  for (const commandType of COMMAND_TYPES) {
    for (const hasKillSwitchCloseBypassMarker of [false, true]) {
      assert.equal(
        safetyCoreKillSwitchBlocksDispatch({
          safetyCoreKillSwitchEngaged: false,
          commandType,
          hasKillSwitchCloseBypassMarker,
        }),
        false,
        `${commandType} must not be refused when the safety-core switch is explicitly disengaged`,
      );
    }
  }
});

test("FAIL-CLOSED: an unreadable/absent safety_core row counts as ENGAGED", () => {
  // Not being able to read the stop button is not permission to trade
  // (CLAUDE.md §1). readSafetyCoreKillSwitchEngaged returns null both when the
  // query throws and when the singleton row has never been created.
  for (const unknown of [null, undefined]) {
    assert.equal(
      safetyCoreKillSwitchBlocksDispatch({
        safetyCoreKillSwitchEngaged: unknown,
        commandType: "PLACE_LIVE_MARKET_ORDER",
        hasKillSwitchCloseBypassMarker: false,
      }),
      true,
      "an unknown safety-core kill-switch state must refuse dispatch, never allow it",
    );
  }
});

test("the ONLY exemption is the CLOSE-only Cluster D marker", () => {
  assert.equal(
    safetyCoreKillSwitchBlocksDispatch({
      safetyCoreKillSwitchEngaged: true,
      commandType: "CLOSE_LIVE_POSITION",
      hasKillSwitchCloseBypassMarker: true,
    }),
    false,
    "an operator must still be able to flatten exposure during a halt",
  );
  for (const commandType of ["PLACE_LIVE_MARKET_ORDER", "PLACE_LIVE_PENDING_ORDER", "MODIFY_LIVE_SLTP"]) {
    assert.equal(
      safetyCoreKillSwitchBlocksDispatch({
        safetyCoreKillSwitchEngaged: true,
        commandType,
        hasKillSwitchCloseBypassMarker: true,
      }),
      true,
      `a bypass marker on ${commandType} must not exempt it from the safety-core kill switch`,
    );
  }
});

test("LOCKSTEP: the exemption is exactly the gate-#5 bypass predicate", () => {
  // Owner Ruling 6 — there is exactly ONE kill-switch bypass. If this gate or
  // killSwitchCloseBypassApplies is ever widened independently, this goes red.
  for (const commandType of COMMAND_TYPES) {
    for (const hasBypassMarker of [false, true]) {
      assert.equal(
        safetyCoreKillSwitchBlocksDispatch({
          safetyCoreKillSwitchEngaged: true,
          commandType,
          hasKillSwitchCloseBypassMarker: hasBypassMarker,
        }),
        !killSwitchCloseBypassApplies({ commandType, hasBypassMarker }),
      );
    }
  }
});

test("the pipeline actually READS safety_core (the rank-1 gap)", () => {
  // The audit's evidence was that a grep of this file for safetyCore returned
  // only a comment. Assert the real column read exists.
  assert.match(
    SOURCE,
    /db\.select\(\{\s*k:\s*safetyCoreTable\.killSwitchEngaged\s*\}\)/,
    "liveCommandPipeline must read safety_core.kill_switch_engaged",
  );
});

test("dispatchLiveCommand consults the gate BEFORE the 18-gate evaluator", () => {
  const dispatchStart = SOURCE.indexOf("export async function dispatchLiveCommand");
  assert.ok(dispatchStart > 0, "dispatchLiveCommand must exist in liveCommandPipeline.ts");
  const gateAt = SOURCE.indexOf("safetyCoreKillSwitchBlocksDispatch({", dispatchStart);
  const evaluatorAt = SOURCE.indexOf("evaluateLivePhaseBDispatchGate({", dispatchStart);
  assert.ok(gateAt > 0, "dispatchLiveCommand must call safetyCoreKillSwitchBlocksDispatch");
  assert.ok(evaluatorAt > 0, "dispatchLiveCommand must still run the 18-gate evaluator");
  assert.ok(
    gateAt < evaluatorAt,
    "the safety-core kill-switch pre-gate must run BEFORE the 18-gate evaluator",
  );
});

test("the draft preflight consults the gate too", () => {
  // A halted platform must not accumulate live drafts a user can confirm the
  // moment the switch is released.
  const preflightStart = SOURCE.indexOf("async function preflight(");
  assert.ok(preflightStart > 0, "preflight must exist in liveCommandPipeline.ts");
  const dispatchStart = SOURCE.indexOf("export async function dispatchLiveCommand");
  const gateAt = SOURCE.indexOf("safetyCoreKillSwitchBlocksDispatch({", preflightStart);
  assert.ok(
    gateAt > preflightStart && gateAt < dispatchStart,
    "preflight must consult the safety-core kill switch before creating a live draft",
  );
});

// Capability #44 — manual takeover state machine: pure proofs.
//
// Proven here (offline, no DB):
//   * takeover/release are explicit, non-idempotent presses with typed refusals,
//   * closed positions refuse both transitions,
//   * the automated-command gate refuses under MANUAL_CONTROL and allows under
//     STRATEGY_MANAGED — including legacy/NULL state (pre-migration rows keep
//     behaving exactly as before),
//   * concurrent-automation semantics: once a takeover plan is applied, the
//     gate that every automated seam consults flips atomically with the state.
//
// Run: pnpm --filter @workspace/api-server run test:manual-takeover

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  planTakeover,
  planRelease,
  checkAutomatedCommandAllowed,
  normalizeManagementState,
  DEFAULT_POSITION_MANAGEMENT_STATE,
} from "@workspace/domain/self-trade";

test("legacy/NULL/garbage state normalizes to STRATEGY_MANAGED (fail-safe)", () => {
  assert.equal(normalizeManagementState(null), "STRATEGY_MANAGED");
  assert.equal(normalizeManagementState(undefined), "STRATEGY_MANAGED");
  assert.equal(normalizeManagementState("manual_control"), "STRATEGY_MANAGED"); // exact literal only
  assert.equal(normalizeManagementState("MANUAL_CONTROL"), "MANUAL_CONTROL");
  assert.equal(DEFAULT_POSITION_MANAGEMENT_STATE, "STRATEGY_MANAGED");
});

test("takeover: allowed from STRATEGY_MANAGED, refused when already manual or closed", () => {
  const ok = planTakeover({ state: "STRATEGY_MANAGED", closed: false });
  assert.equal(ok.ok, true);
  assert.equal((ok as { to: string }).to, "MANUAL_CONTROL");

  const dup = planTakeover({ state: "MANUAL_CONTROL", closed: false });
  assert.equal(dup.ok, false);
  assert.equal((dup as { reason: string }).reason, "ALREADY_MANUAL");

  const closed = planTakeover({ state: "STRATEGY_MANAGED", closed: true });
  assert.equal(closed.ok, false);
  assert.equal((closed as { reason: string }).reason, "POSITION_CLOSED");
});

test("release: only from MANUAL_CONTROL, and it is explicit", () => {
  const ok = planRelease({ state: "MANUAL_CONTROL", closed: false });
  assert.equal(ok.ok, true);
  assert.equal((ok as { to: string }).to, "STRATEGY_MANAGED");

  const notManual = planRelease({ state: "STRATEGY_MANAGED", closed: false });
  assert.equal(notManual.ok, false);
  assert.equal((notManual as { reason: string }).reason, "NOT_MANUAL");

  const closed = planRelease({ state: "MANUAL_CONTROL", closed: true });
  assert.equal(closed.ok, false);
  assert.equal((closed as { reason: string }).reason, "POSITION_CLOSED");
});

test("automated commands refuse under MANUAL_CONTROL with a typed reason", () => {
  const refused = checkAutomatedCommandAllowed("MANUAL_CONTROL");
  assert.equal(refused.allowed, false);
  assert.equal((refused as { reason: string }).reason, "MANUAL_CONTROL_ACTIVE");
  assert.match((refused as { message: string }).message, /manual control/i);
});

test("automated commands allowed under STRATEGY_MANAGED and legacy state", () => {
  assert.equal(checkAutomatedCommandAllowed("STRATEGY_MANAGED").allowed, true);
  assert.equal(checkAutomatedCommandAllowed(null).allowed, true);
  assert.equal(checkAutomatedCommandAllowed(undefined).allowed, true);
});

test("concurrent-automation flow: takeover flips the gate; release restores it", () => {
  // Simulate the position row the routes persist.
  let state: unknown = "STRATEGY_MANAGED";
  assert.equal(checkAutomatedCommandAllowed(state).allowed, true);

  const takeover = planTakeover({ state, closed: false });
  assert.equal(takeover.ok, true);
  state = (takeover as { to: string }).to;

  // Every automated command that reads through the gate now refuses …
  assert.equal(checkAutomatedCommandAllowed(state).allowed, false);
  // … and a second concurrent takeover press is refused, not silently absorbed.
  assert.equal(planTakeover({ state, closed: false }).ok, false);

  const release = planRelease({ state, closed: false });
  assert.equal(release.ok, true);
  state = (release as { to: string }).to;
  assert.equal(checkAutomatedCommandAllowed(state).allowed, true);
});

// ── Seam coverage: EVERY autonomous management dispatcher consults the gate ──
//
// A pure gate proves nothing if a dispatch seam skips it. Source-level proof
// (same idiom as championChallenger/draftCounterfactual seam tests): both
// automated-management seams — missionExitManager AND the self-trade
// livePositionManager — must call checkAutomatedCommandAllowed BEFORE their
// first executeInstant dispatch. Deleting the gate call from either file
// turns this red.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

for (const rel of [
  "../missionExitManager.ts",
  "../selfTrade/livePositionManager.ts",
]) {
  test(`automated seam ${rel} gates dispatch on checkAutomatedCommandAllowed`, () => {
    const src = readFileSync(path.resolve(here, rel), "utf8");
    const gateAt = src.indexOf("checkAutomatedCommandAllowed(");
    assert.ok(gateAt >= 0, `${rel} must call checkAutomatedCommandAllowed`);
    const dispatchAt = src.indexOf("executeInstant(");
    if (dispatchAt >= 0) {
      assert.ok(
        gateAt < dispatchAt,
        `${rel} must consult the manual-takeover gate before its first executeInstant dispatch`,
      );
    }
  });
}

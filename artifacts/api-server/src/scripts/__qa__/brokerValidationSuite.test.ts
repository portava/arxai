// Broker validation suite (Tier 1 finalization, item 11): the plan names a
// real CI proof for every scenario, and the runner refuses LIVE, an unnamed
// user and a run without explicit demo-order consent. Pure; places nothing.
//
// Run: pnpm --filter @workspace/api-server run test:broker-validation-suite

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCENARIOS, parseArgs, refuseRun, runExternal, demoSnapshotMatches, wideningWasBlocked, knownDemoBridgeIncompatibility, type DemoSnapshot } from "../brokerValidationSuite.js";

test("known EA protocol and partial-close incompatibilities stop the validation preflight", () => {
  for (const version of ["1.26", "1.27", "1.28", "1.29", "v1.29", "1.29.0"]) {
    assert.match(knownDemoBridgeIncompatibility(version)!, /entire position/);
  }
  for (const version of ["1.30", "1.40", "1.50", "1.51", "1.52", "1.54"]) {
    assert.match(knownDemoBridgeIncompatibility(version)!, /mailbox/);
  }
  // Unknown versions still face the existing route/consent/snapshot checks;
  // this source compatibility check makes no claims about their capabilities.
  assert.equal(knownDemoBridgeIncompatibility(null), null);
  assert.equal(knownDemoBridgeIncompatibility("custom-build"), null);
});

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../../../package.json", import.meta.url)), "utf8")) as { scripts: Record<string, string> };

test("every scenario names CI proofs that exist", () => {
  assert.ok(SCENARIOS.length >= 10);
  assert.equal(new Set(SCENARIOS.map((s) => s.id)).size, SCENARIOS.length);
  for (const s of SCENARIOS) {
    assert.ok(s.offlineProof.length > 0, s.id);
    for (const p of s.offlineProof) assert.ok(pkg.scripts[p], `${s.id}: ${p} is not a script`);
  }
  assert.ok(pkg.scripts["validate:broker"]);
});

test("the external run covers the full demo lifecycle", () => {
  assert.deepEqual(SCENARIOS.filter((s) => s.external).map((s) => s.id),
    ["preflight", "entry_fill", "guardian_verifies", "tighten_stop", "automation_cannot_widen", "partial_close", "full_close"]);
});

test("the runner refuses LIVE, an unnamed user, oversize lots and a run without consent", () => {
  const ok = parseArgs(["--run", "--user-id", "7", "--lots", "0.02", "--confirm-demo-orders"]);
  assert.equal(refuseRun(ok), null);
  assert.match(refuseRun({ ...ok, venue: "LIVE" })!, /only runs against DEMO/);
  assert.match(refuseRun(parseArgs(["--run", "--confirm-demo-orders"]))!, /--user-id/);
  assert.match(refuseRun({ ...ok, lots: 1 })!, /--lots/);
  assert.match(refuseRun({ ...ok, confirmed: false })!, /--confirm-demo-orders/);
  for (const lots of [0, 0.01, 0.025, NaN, Infinity]) assert.match(refuseRun({ ...ok, lots })!, /--lots/);
});

test("direct runner calls cannot bypass DEMO-only or explicit-consent checks", async () => {
  const ok = parseArgs(["--user-id", "7", "--confirm-demo-orders"]);
  await assert.rejects(runExternal({ ...ok, venue: "LIVE" }), /only runs against DEMO/);
  await assert.rejects(runExternal({ ...ok, confirmed: false }), /--confirm-demo-orders/);
});

test("broker evidence needs a fresh complete sweep and the actual stop and remaining volume", () => {
  const expected = { after: 10_000, now: 20_000, lots: 0.01, stop: 1.1 };
  const snapshot: DemoSnapshot = { demo: true, ambiguous: false, snapshotAt: 19_000,
    position: { status: "OPEN", lots: 0.01, stop: 1.1, at: 18_000 } };
  assert.equal(demoSnapshotMatches(snapshot, expected), true);
  for (const patch of [{ demo: false }, { ambiguous: true }, { snapshotAt: null }, { snapshotAt: 9_999 }, { snapshotAt: 20_001 }, { position: null }]) {
    assert.equal(demoSnapshotMatches({ ...snapshot, ...patch }, expected), false);
  }
  for (const patch of [{ lots: 0.02 }, { lots: NaN }, { stop: 1.09 }, { stop: null }, { at: 9_999 }, { at: 20_001 }, { status: "CLOSED" }]) {
    assert.equal(demoSnapshotMatches({ ...snapshot, position: { ...snapshot.position!, ...patch } }, expected), false);
  }
  assert.equal(demoSnapshotMatches(snapshot, { ...expected, now: 80_000 }), false);
  // A result may update the row before acknowledgement, but the complete
  // broker sweep must be newer than the acknowledgement itself.
  assert.equal(demoSnapshotMatches(snapshot, { ...expected, after: 18_500, positionAfter: 10_000 }), true);
  assert.equal(demoSnapshotMatches({ ...snapshot, snapshotAt: 18_000 }, { ...expected, after: 18_500, positionAfter: 10_000 }), false);
});

test("a close acknowledgement or old closed row cannot stand in for a new broker sweep", () => {
  const expected = { after: 10_000, now: 20_000, lots: 0, stop: null };
  const empty: DemoSnapshot = { demo: true, ambiguous: false, snapshotAt: 19_000, position: null };
  assert.equal(demoSnapshotMatches(empty, expected), true);
  assert.equal(demoSnapshotMatches({ ...empty, snapshotAt: 9_999 }, expected), false);
  assert.equal(demoSnapshotMatches({ ...empty, position: { status: "OPEN", lots: 0.01, stop: 1.1, at: 19_000 } }, expected), false);
  assert.equal(demoSnapshotMatches({ ...empty, position: { status: "CLOSED", lots: 0.01, stop: 1.1, at: 9_999 } }, expected), false);
  assert.equal(demoSnapshotMatches({ ...empty, position: { status: "CLOSED", lots: 0.01, stop: 1.1, at: 19_000 } }, expected), true);
});

test("an unrelated refusal does not prove automation cannot widen a stop", () => {
  assert.equal(wideningWasBlocked("RISK_GATE_FAILED:stop_loss_required,per_trade_loss_limit"), true);
  for (const reason of [null, "BROKER_UNAVAILABLE", "RISK_GATE_FAILED:trading_halt", "RISK_GATE_FAILED:stop_loss_required_extra"]) {
    assert.equal(wideningWasBlocked(reason), false);
  }
});

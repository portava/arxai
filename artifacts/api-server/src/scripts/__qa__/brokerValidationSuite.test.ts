// Broker validation suite (Tier 1 finalization, item 11): the plan names a
// real CI proof for every scenario, and the runner refuses LIVE, an unnamed
// user and a run without explicit demo-order consent. Pure; places nothing.
//
// Run: pnpm --filter @workspace/api-server run test:broker-validation-suite

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCENARIOS, parseArgs, refuseRun } from "../brokerValidationSuite.js";

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
});

// The guided↔MT5 parity record — the artifact PROJECT_STATE.md said did not
// exist. These tests keep it honest: total, informative, free of unfixed GAPs,
// and the two 2026-08-30 GAP fixes actually wired where the record says.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  GUIDED_MT5_PIPELINE_PARITY,
  GUIDED_MT5_PARITY_CHECK_COUNT,
  assertGuidedMt5Parity,
} from "@workspace/domain/safety-contracts/guidedMt5PipelineParity";

test("the parity record is total and self-consistent", () => {
  assert.equal(Object.keys(GUIDED_MT5_PIPELINE_PARITY).length, GUIDED_MT5_PARITY_CHECK_COUNT);
  const verdict = assertGuidedMt5Parity();
  assert.deepEqual(verdict.problems, []);
  assert.equal(verdict.ok, true);
});

test("no GAP disposition survives — both audit GAPs were fixed, not relabeled", () => {
  for (const [name, e] of Object.entries(GUIDED_MT5_PIPELINE_PARITY)) {
    assert.notEqual((e as { disposition: string }).disposition, "GAP", `${name} is still a GAP`);
  }
  // The fixes must be REAL enforcement claims naming the guided wall…
  for (const fixed of ["RISK_LOCK_PRE_GATE", "CLOSE_ONLY_PRE_GATE"]) {
    const e = GUIDED_MT5_PIPELINE_PARITY[fixed]!;
    assert.equal(e.disposition, "EQUIVALENT", `${fixed} must be EQUIVALENT after the fix`);
    assert.match(String(e.guidedEnforcedBy), /guidedDispatchEntry/);
  }
  // …and the named enforcer must actually exist in the wired code, so the
  // record cannot outlive the wall it describes.
  const entry = readFileSync(new URL("../guidedDispatchEntry.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.match(entry, /closeOnlyBlocksDispatch\(/, "the close-only wall is gone from the entry");
  assert.match(entry, /activeRiskLockBlockReason\(/, "the risk-lock wall is gone from the entry");
});

test("every WEAKER disposition says exactly what is weaker", () => {
  const weaker = Object.entries(GUIDED_MT5_PIPELINE_PARITY)
    .filter(([, e]) => e.disposition === "WEAKER");
  assert.ok(weaker.length > 0, "the audit found WEAKER dispositions; hiding them would be a lie");
  for (const [name, e] of weaker) {
    assert.ok(e.reason.length >= 60,
      `${name}: a WEAKER claim needs a real explanation, not a label`);
  }
});

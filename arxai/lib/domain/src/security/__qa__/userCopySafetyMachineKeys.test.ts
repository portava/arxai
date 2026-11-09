// scrubUserCopyDeep — machine-field allowlist (owner screenshot 2026-10-27, V75 1m).
//
// The read-chart wire carries machine enums (`readLayer: "STRUCTURAL_ONLY"`,
// `tradeHealthFreshness: "HISTORICAL_ONLY"`) beside narrative copy. The
// SCREAMING_SNAKE leak rule blanked both enums to "", so the client could not
// see the read was STRUCTURAL_ONLY and rendered "Full read" / "Live read on V75
// 1m." next to "Exact entry, stop, and target levels withheld". These tests lock
// that an explicit key-name allowlist keeps the enum values intact while every
// narrative string is still scrubbed (the leak guard must not re-open).

import { test } from "node:test";
import assert from "node:assert/strict";
import { findInternalLeaks, scrubUserCopyDeep } from "../userCopySafety";

const PRESERVE = ["readLayer", "tradeHealthFreshness", "reasonCode", "basis"] as const;

test("machine enum keys survive the deep scrub when allowlisted", () => {
  const out = scrubUserCopyDeep(
    {
      readLayer: "STRUCTURAL_ONLY",
      tradeHealthFreshness: "HISTORICAL_ONLY",
      reasonCode: "FEED_NOT_LIVE_CONFIRMED",
      basis: "VERIFIED",
      blockedReason: "Live trade setup withheld (LIVE_BLOCKED) until the feed confirms.",
    },
    { preserveKeys: PRESERVE },
  );
  assert.equal(out.readLayer, "STRUCTURAL_ONLY");
  assert.equal(out.tradeHealthFreshness, "HISTORICAL_ONLY");
  assert.equal(out.reasonCode, "FEED_NOT_LIVE_CONFIRMED");
  assert.equal(out.basis, "VERIFIED");
  assert.deepEqual(findInternalLeaks(out.blockedReason), []);
  assert.equal(out.blockedReason, "Live trade setup withheld until the feed confirms.");
});

test("without the allowlist the multi-segment enums are blanked (documents the hazard)", () => {
  const out = scrubUserCopyDeep({ readLayer: "STRUCTURAL_ONLY", tradeHealthFreshness: "HISTORICAL_ONLY" });
  assert.equal(out.readLayer, "");
  assert.equal(out.tradeHealthFreshness, "");
});

test("allowlist is by KEY NAME: a narrative field that is purely an internal code is still scrubbed", () => {
  const out = scrubUserCopyDeep(
    { readLayer: "STRUCTURAL_ONLY", headline: "LIVE_BLOCKED", trustLine: "ARX_LIVE_BROKER_EXECUTION_ENABLED" },
    { preserveKeys: PRESERVE },
  );
  assert.equal(out.readLayer, "STRUCTURAL_ONLY");
  assert.equal(out.headline, "");
  assert.equal(out.trustLine, "");
});

test("a non-enum value under a preserved key is still scrubbed like narrative", () => {
  const out = scrubUserCopyDeep(
    { reasonCode: "see /api/internal/gates for LIVE_BLOCKED", basis: "sk-abcdefghijklmnop" },
    { preserveKeys: PRESERVE },
  );
  assert.deepEqual(findInternalLeaks(out.reasonCode), []);
  assert.deepEqual(findInternalLeaks(out.basis), []);
});

test("preserved keys apply at any depth; nested narrative strings stay clean", () => {
  const out = scrubUserCopyDeep(
    { fvgStrategyRead: { stage: "FVG_ENTRY_ZONE", note: "gate TWELVEDATA_API_KEY missing" }, cautions: ["SESSION_SECRET"] },
    { preserveKeys: ["stage"] },
  );
  assert.equal(out.fvgStrategyRead.stage, "FVG_ENTRY_ZONE");
  assert.deepEqual(findInternalLeaks(out.fvgStrategyRead.note), []);
  assert.deepEqual(findInternalLeaks(out.cautions[0]), []);
});

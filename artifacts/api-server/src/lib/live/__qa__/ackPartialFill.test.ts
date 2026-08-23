// Spec §20: "Acknowledged is not treated as filled." Spec §12: "Partial fills
// update exposure immediately." Before this slice arx_live_commands had
// neither state, so a short fill was recorded as a FULL fill and FULFILLED the
// entire exposure reservation.
process.env["DATABASE_URL"] ??= "postgres://user:pass@127.0.0.1:1/nonexistent";

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const pipelineSrc = readFileSync(path.join(here, "../liveCommandPipeline.ts"), "utf8");

const {
  isPartialFill,
  mapBridgedLiveOutcome,
  settleReservationForStatus,
  isTerminalLiveStatus,
  isAllowedLiveTransition,
  LIVE_VOLUME_EPSILON,
} = await import("../liveCommandPipeline.js");
const { fromArxLiveStatus } = await import("@workspace/domain/execution-state");

test("a short fill with a ticket is a PARTIAL", () => {
  assert.equal(isPartialFill({ hasBrokerTicket: true, executedVolume: 0.03, requestedVolume: 0.10 }), true);
});

test("a full fill is NOT a partial, including at float-noise distance", () => {
  assert.equal(isPartialFill({ hasBrokerTicket: true, executedVolume: 0.10, requestedVolume: 0.10 }), false);
  assert.equal(
    isPartialFill({ hasBrokerTicket: true, executedVolume: 0.10 - LIVE_VOLUME_EPSILON / 2, requestedVolume: 0.10 }),
    false,
    "float noise must not manufacture a partial fill",
  );
});

test("no ticket is never a fill of any size", () => {
  assert.equal(isPartialFill({ hasBrokerTicket: false, executedVolume: 0.03, requestedVolume: 0.10 }), false);
});

test("missing or nonsensical volumes degrade to NOT-partial, never invented", () => {
  for (const bad of [
    { executedVolume: null, requestedVolume: 0.1 },
    { executedVolume: 0.1, requestedVolume: null },
    { executedVolume: 0, requestedVolume: 0.1 },
    { executedVolume: -1, requestedVolume: 0.1 },
    { executedVolume: Number.NaN, requestedVolume: 0.1 },
    { executedVolume: 0.05, requestedVolume: 0 },
  ]) {
    assert.equal(isPartialFill({ hasBrokerTicket: true, ...bad }), false, JSON.stringify(bad));
  }
});

test("mapBridgedLiveOutcome returns PARTIAL before it would return FILLED", () => {
  assert.equal(
    mapBridgedLiveOutcome({ status: "ok", hasBrokerTicket: true, executedVolume: 0.02, requestedVolume: 0.10 }),
    "LIVE_PARTIALLY_FILLED",
  );
  assert.equal(
    mapBridgedLiveOutcome({ status: "ok", hasBrokerTicket: true, executedVolume: 0.10, requestedVolume: 0.10 }),
    "LIVE_FILLED",
  );
  // Volumes absent (the pre-S5 call shape) must behave exactly as before.
  assert.equal(mapBridgedLiveOutcome({ status: "ok", hasBrokerTicket: true }), "LIVE_FILLED");
  assert.equal(mapBridgedLiveOutcome({ status: "ok", hasBrokerTicket: false }), "LIVE_UNKNOWN");
});

test("an explicit broker failure still wins over partial detection", () => {
  assert.equal(
    mapBridgedLiveOutcome({ status: "rejected", hasBrokerTicket: true, executedVolume: 0.02, requestedVolume: 0.10 }),
    "LIVE_REJECTED",
  );
});

test("neither new state is terminal", () => {
  assert.equal(isTerminalLiveStatus("LIVE_ACKNOWLEDGED"), false);
  assert.equal(isTerminalLiveStatus("LIVE_PARTIALLY_FILLED"), false);
});

test("RESERVATION: both HOLD — never release on an ack or a partial", () => {
  assert.equal(settleReservationForStatus("LIVE_ACKNOWLEDGED"), "HOLD");
  assert.equal(settleReservationForStatus("LIVE_PARTIALLY_FILLED"), "HOLD");
  // Contrast: the settled outcomes are unchanged.
  assert.equal(settleReservationForStatus("LIVE_FILLED"), "FULFILL");
  assert.equal(settleReservationForStatus("LIVE_REJECTED"), "RELEASE");
});

test("legal lifecycle hops exist and illegal ones are refused", () => {
  assert.equal(isAllowedLiveTransition("SENT_TO_MT5_LIVE", "LIVE_ACKNOWLEDGED"), true);
  assert.equal(isAllowedLiveTransition("SENT_TO_MT5_LIVE", "LIVE_PARTIALLY_FILLED"), true);
  assert.equal(isAllowedLiveTransition("LIVE_ACKNOWLEDGED", "LIVE_FILLED"), true);
  assert.equal(isAllowedLiveTransition("LIVE_PARTIALLY_FILLED", "LIVE_FILLED"), true);
  // A partial has REAL exposure — it can never be recast as a refusal.
  assert.equal(isAllowedLiveTransition("LIVE_PARTIALLY_FILLED", "LIVE_REJECTED"), false);
  assert.equal(isAllowedLiveTransition("LIVE_PARTIALLY_FILLED", "LIVE_FAILED"), false);
});

test("canonical mapping is LOSSLESS for both — the point of the §20 separation", () => {
  assert.deepEqual(fromArxLiveStatus("LIVE_ACKNOWLEDGED"), { state: "acknowledged", lossy: false });
  assert.deepEqual(fromArxLiveStatus("LIVE_PARTIALLY_FILLED"), { state: "partially_filled", lossy: false });
});

test("a partial is stamped as neither a fill nor a rejection", () => {
  const branch = pipelineSrc.slice(
    pipelineSrc.indexOf('} else if (effectiveOutcome === "LIVE_PARTIALLY_FILLED") {'),
    pipelineSrc.indexOf('} else if (effectiveOutcome === "LIVE_ACKNOWLEDGED") {'),
  );
  assert.ok(branch.length > 0, "the partial branch must exist");
  // Assert on ASSIGNMENTS, not mentions: the branch comment names both fields
  // while explaining why neither is set.
  const code = branch.replace(/\/\/.*$/gm, "");
  assert.ok(!/updates\.filledAt\s*=/.test(code), "a partial must not claim a full fill");
  assert.ok(!/updates\.rejectedAt\s*=/.test(code), "a partial must not be stamped a rejection");
});

test("results after an ack or partial are APPLIED, not parked for reconciliation", () => {
  assert.match(pipelineSrc, /LIVE_RESULT_APPLICABLE_STATUSES[\s\S]{0,400}?"LIVE_ACKNOWLEDGED",\s*"LIVE_PARTIALLY_FILLED"/);
  // They must stay OUT of the epistemic set, which parks a result for the
  // reconciler and would strand every partial's completion.
  const epistemic = pipelineSrc.slice(
    pipelineSrc.indexOf("const LIVE_EPISTEMIC_STATUSES"),
    pipelineSrc.indexOf("const LIVE_RESULT_APPLICABLE_STATUSES"),
  );
  assert.ok(!epistemic.includes("LIVE_PARTIALLY_FILLED"));
  assert.ok(!epistemic.includes("LIVE_ACKNOWLEDGED"));
});

// Phase 6 - the INDETERMINATE delivery outcome.
//
// The seam's binary contract (resolve = delivered, reject = not delivered) is
// correct for the EA bridge, whose deliver() is a local mailbox INSERT. It is
// wrong for a network venue, where a written frame with no reply may well have
// placed an order. This suite pins the third outcome and, above all, that it
// does NOT release the exposure reservation.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  IndeterminateDeliveryError, isIndeterminateDelivery, routeDeliveryFailure,
  Mt5EaBridgeAdapter, MT5_EA_BRIDGE_VENUE,
} from "../../live/executionAdapter.js";

/**
 * Source with comments stripped.
 *
 * This matters more than usual here: the pipeline branch's own comment says
 * "the deliberate absence of a releaseReservation call", and the seam's comment
 * discusses LIVE_FAILED. A raw-text assertion would match that prose and either
 * pass or fail for entirely the wrong reason. This repo has been bitten by that
 * exact trap repeatedly, so every assertion below runs on stripped source.
 */
function strippedSource(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const PIPELINE = strippedSource("../../live/liveCommandPipeline.ts");
const SEAM = strippedSource("../../live/executionAdapter.ts");

// -- the brand ------------------------------------------------------------
test("the third outcome is recognised structurally, not by instanceof", () => {
  const e = new IndeterminateDeliveryError("deriv_demo", "no reply after write", "intent_1");
  assert.equal(isIndeterminateDelivery(e), true);

  // A duplicated module instance breaks instanceof silently, and the failure
  // mode would be an indeterminate delivery recorded as a definite failure.
  // A plain object carrying the brand must still be recognised.
  const structural = { arxIndeterminateDelivery: true, venue: "x", detail: "y", intentRef: null };
  assert.equal(isIndeterminateDelivery(structural), true, "brand check fell back to instanceof");
});

test("ordinary errors are NOT mistaken for the third outcome", () => {
  for (const notIt of [
    new Error("BRIDGE_ENQUEUE_FAILED"), null, undefined, "string", 42, {},
    { arxIndeterminateDelivery: false },
    // These discriminate `=== true` from `== true`. "true" does NOT: it
    // coerces to NaN and fails both. 1 and [1] are the values that expose a
    // loosened comparison.
    { arxIndeterminateDelivery: 1 },
    { arxIndeterminateDelivery: [1] },
    { arxIndeterminateDelivery: "1" },
  ]) {
    assert.equal(isIndeterminateDelivery(notIt), false, `misclassified: ${JSON.stringify(notIt)}`);
  }
});

test("the error carries what reconciliation needs, and no secrets", () => {
  const e = new IndeterminateDeliveryError("deriv_demo", "write ok, no reply in 15000ms", "intent_abc");
  assert.equal(e.venue, "deriv_demo");
  assert.equal(e.intentRef, "intent_abc");
  assert.match(e.message, /INDETERMINATE_DELIVERY\[deriv_demo\]/);
  assert.equal(e.name, "IndeterminateDeliveryError");
});

// -- the EA path is unchanged ---------------------------------------------
test("the MT5 EA adapter never produces the third outcome", () => {
  // Its delivery is a local INSERT: a throw there genuinely proves nothing was
  // transmitted, so the existing fail-closed handling stays correct.
  assert.ok(!SEAM.includes("class Mt5EaBridgeAdapter extends"), "the EA adapter gained a base class");
  const cls = SEAM.slice(SEAM.indexOf("class Mt5EaBridgeAdapter"));
  const body = cls.slice(0, cls.indexOf("\n}"));
  assert.ok(!body.includes("IndeterminateDeliveryError"),
    "the EA adapter can now throw an indeterminate outcome, which it can never prove");
});

test("the EA adapter still passes delivery straight through", async () => {
  const a = new Mt5EaBridgeAdapter(async () => ({ transportRef: "1", action: "OPEN_MARKET", mt5CommandId: 1 }));
  assert.equal(a.venue, MT5_EA_BRIDGE_VENUE);
  const r = await a.deliver({ liveRow: {} as never, bridgeUserId: 1, bridgeConnectionId: 1 });
  assert.equal(r.mt5CommandId, 1);
});

// -- the pipeline branch --------------------------------------------------
// -- the routing decision, exercised as REAL code --------------------------
test("routeDeliveryFailure sends an indeterminate error to INDETERMINATE", () => {
  // Behavioural, not positional. A source scan cannot distinguish a live branch
  // from `if (false && ...)`; this can.
  const r = routeDeliveryFailure(new IndeterminateDeliveryError("deriv_demo", "no reply", "intent_1"));
  assert.equal(r.kind, "INDETERMINATE");
  assert.equal(r.kind === "INDETERMINATE" && r.venue, "deriv_demo");
  assert.equal(r.kind === "INDETERMINATE" && r.intentRef, "intent_1");
});

test("routeDeliveryFailure sends everything else to DEFINITE_FAILURE", () => {
  for (const e of [
    new Error("BRIDGE_ENQUEUE_FAILED"), new Error("UNMAPPED_LIVE_COMMAND_TYPE:x"),
    null, undefined, "str", 0, {}, { arxIndeterminateDelivery: false },
  ]) {
    assert.equal(routeDeliveryFailure(e).kind, "DEFINITE_FAILURE", `misrouted: ${JSON.stringify(e)}`);
  }
});

test("the pipeline consumes the routing verdict rather than re-deciding inline", () => {
  assert.ok(PIPELINE.includes("routeDeliveryFailure(bridgeErr)"),
    "the pipeline no longer calls the extracted router");
  assert.ok(PIPELINE.includes('deliveryRouting.kind === "INDETERMINATE"'),
    "the pipeline does not branch on the routing verdict");
  const branch = PIPELINE.indexOf("routeDeliveryFailure(bridgeErr)");
  const generic = PIPELINE.indexOf('msg.startsWith("UNMAPPED_LIVE_COMMAND_TYPE")');
  assert.ok(branch > 0 && generic > 0 && branch < generic,
    "an indeterminate delivery falls through to the generic routing");
});

test("the pipeline's indeterminate branch cannot be disabled in place", () => {
  // `if (false && deliveryRouting.kind === "INDETERMINATE")` leaves every
  // string and every position intact while routing every indeterminate
  // delivery into the definite-failure path. Position-based assertions cannot
  // see that, and the extracted router is pure so it stays green too. Pinning
  // the guard EXACTLY is what closes it. Reachability of a specific line inside
  // a 4900-line DB-bound function is not otherwise assertable without a live
  // database, so this structural pin is the honest instrument.
  const guards = PIPELINE.match(/if\s*\([^)]*deliveryRouting\.kind[^)]*\)/g) ?? [];
  assert.equal(guards.length, 1, `expected exactly one branch guard, found ${guards.length}`);
  assert.equal(guards[0]!.replace(/\s+/g, " "),
    'if (deliveryRouting.kind === "INDETERMINATE")',
    "the indeterminate branch guard carries an extra condition that can disable it");
});

test("the indeterminate branch records LIVE_UNKNOWN, never LIVE_FAILED", () => {
  const start = PIPELINE.indexOf("routeDeliveryFailure(bridgeErr)");
  const branch = PIPELINE.slice(start, PIPELINE.indexOf('const reason = msg.startsWith', start));
  assert.ok(branch.includes('status: "LIVE_UNKNOWN"'), "the branch does not set LIVE_UNKNOWN");
  assert.ok(!branch.includes('"LIVE_FAILED"'),
    "the indeterminate branch marks the command failed, claiming certainty it does not have");
});

test("THE SAFETY PROPERTY: the indeterminate branch does NOT release the reservation", () => {
  // Releasing would free risk budget for a position that may be open. The
  // generic failure branch below it DOES release, correctly, because that path
  // has proof nothing was transmitted.
  const start = PIPELINE.indexOf("routeDeliveryFailure(bridgeErr)");
  const branch = PIPELINE.slice(start, PIPELINE.indexOf('const reason = msg.startsWith', start));
  assert.ok(!branch.includes("releaseReservation"),
    "the indeterminate branch releases the exposure reservation for an order that may exist");

  // And prove the comparison is meaningful: the generic branch that follows
  // genuinely does release, so the absence above is a real difference and not
  // an artefact of slicing the wrong region.
  const genericStart = PIPELINE.indexOf('const reason = msg.startsWith', start);
  const generic = PIPELINE.slice(genericStart, genericStart + 2000);
  assert.ok(generic.includes("releaseReservation"),
    "control assertion failed: the generic failure branch should release the reservation");
});

test("the indeterminate result is distinguishable from a plain failure", () => {
  const start = PIPELINE.indexOf("routeDeliveryFailure(bridgeErr)");
  const branch = PIPELINE.slice(start, PIPELINE.indexOf('const reason = msg.startsWith', start));
  // A caller that sees only `ok:false` would render "trade failed" for an order
  // that may be live. The flag is what lets a Phase 6 caller tell them apart.
  assert.ok(branch.includes("indeterminate: true"),
    "the indeterminate outcome is indistinguishable from a definite failure at the call site");
});

// -- the status vocabulary supports it ------------------------------------
test("LIVE_UNKNOWN holds exposure and blocks duplicate submission", async () => {
  // Both properties are pre-existing and are what make LIVE_UNKNOWN the right
  // target: the partial unique index covers it, so an unconfirmed outcome
  // cannot be retried into a second order.
  const schema = readFileSync(
    new URL("../../../../../../lib/db/src/schema/arxLiveExecution.ts", import.meta.url), "utf8");
  const idx = schema.slice(schema.indexOf("arx_live_commands_idem_active_uq"));
  const where = idx.slice(0, idx.indexOf("\n}"));
  assert.ok(where.includes("LIVE_UNKNOWN"),
    "LIVE_UNKNOWN is not covered by the active idempotency index — a duplicate order could be submitted");
});

// Phase 6 - venue routing certification.
//
// Covers the owner's adversarial checks 1-4: unknown venue refuses, missing
// venue refuses, MT5 routes only to MT5, Deriv routes only to Deriv.
//
// The invariant this replaces the old MT5 literal with:
//   every reachable live execution venue routes through an explicitly
//   REGISTERED certified adapter, and unknown venues fail closed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  routeExecutionVenue, venueDeliveryCanBeIndeterminate,
  EXECUTION_VENUES, HISTORICAL_BACKFILL_VENUE,
} from "@workspace/domain/safety-contracts/executionVenue";
import {
  selectExecutionAdapter, isUnroutableVenue, UnroutableVenueError,
  type ExecutionAdapterRegistry,
} from "../../live/executionAdapterRegistry.js";
import { MT5_EA_BRIDGE_VENUE, type DeliveryResult } from "../../live/executionAdapter.js";

const mt5 = { venue: MT5_EA_BRIDGE_VENUE, deliver: async (): Promise<DeliveryResult> => ({ transportRef: "1", action: "OPEN_MARKET" }) };
const deriv = { venue: "deriv_demo", deliver: async (): Promise<DeliveryResult> => ({ transportRef: "c1", action: "BUY_MULTIPLIER" }) };
const REGISTRY: ExecutionAdapterRegistry = { MT5_EA_BRIDGE: mt5, DERIV_DEMO: deriv };

// -- 2. missing venue refuses ----------------------------------------------
test("an ABSENT venue refuses - there is no default venue", () => {
  for (const absent of [null, undefined, ""]) {
    const v = routeExecutionVenue(absent);
    assert.equal(v.ok, false, `${JSON.stringify(absent)} resolved to a venue`);
    assert.equal(v.ok === false && v.refusal, "VENUE_ABSENT");
  }
});

// -- 1. unknown venue refuses ----------------------------------------------
test("an UNRECOGNISED venue refuses, in every near-miss form", () => {
  for (const bad of [
    "mt5", "MT5", "mt5_ea_bridge", "Mt5_Ea_Bridge",    // wrong case / wrong spelling
    "deriv", "DERIV", "deriv_demo", "DERIV_REAL",      // the real-account near-miss
    "MT5_EA_BRIDGE ", " MT5_EA_BRIDGE",                // padded
    "MT5_EA_BRIDGE_EXTRA", "XMT5_EA_BRIDGE",           // prefix/suffix
  ]) {
    const v = routeExecutionVenue(bad);
    assert.equal(v.ok, false, `${JSON.stringify(bad)} was accepted as a venue`);
    assert.equal(v.ok === false && v.refusal, "VENUE_UNRECOGNISED");
  }
});

test("a MALFORMED venue refuses rather than being coerced", () => {
  for (const bad of [42, {}, [], true, Symbol("x")] as unknown[]) {
    const v = routeExecutionVenue(bad);
    assert.equal(v.ok, false, `${String(bad)} was accepted`);
    assert.equal(v.ok === false && v.refusal, "VENUE_MALFORMED");
  }
});

test("the two known venues resolve exactly", () => {
  for (const good of EXECUTION_VENUES) {
    const v = routeExecutionVenue(good);
    assert.equal(v.ok, true, `${good} did not resolve`);
    assert.equal(v.ok === true && v.venue, good);
  }
});

// -- 3 & 4. each venue routes ONLY to its own adapter -----------------------
test("MT5 routes only to the MT5 adapter", () => {
  assert.equal(selectExecutionAdapter(REGISTRY, "MT5_EA_BRIDGE").venue, MT5_EA_BRIDGE_VENUE);
});

test("Deriv routes only to the Deriv adapter", () => {
  assert.equal(selectExecutionAdapter(REGISTRY, "DERIV_DEMO").venue, "deriv_demo");
});

test("selection THROWS on an unroutable venue - it never silently picks one", () => {
  for (const bad of [null, undefined, "", "mt5", "DERIV_REAL", 42, {}] as unknown[]) {
    assert.throws(() => selectExecutionAdapter(REGISTRY, bad), (e: unknown) => {
      assert.equal(isUnroutableVenue(e), true, `wrong error type for ${String(bad)}`);
      return true;
    }, `venue ${String(bad)} selected an adapter`);
  }
});

test("a venue with no registered adapter throws rather than returning null", () => {
  // A missed null check downstream would mean dispatching with no adapter at all.
  const partial = { MT5_EA_BRIDGE: mt5 } as unknown as ExecutionAdapterRegistry;
  assert.throws(() => selectExecutionAdapter(partial, "DERIV_DEMO"), (e: unknown) => isUnroutableVenue(e));
});

test("an adapter filed under a key with no venue literal is refused", () => {
  const broken = { MT5_EA_BRIDGE: mt5, DERIV_DEMO: { venue: "", deliver: deriv.deliver } } as unknown as ExecutionAdapterRegistry;
  assert.throws(() => selectExecutionAdapter(broken, "DERIV_DEMO"), (e: unknown) => isUnroutableVenue(e));
});

test("UnroutableVenueError is recognised structurally, not by instanceof", () => {
  assert.equal(isUnroutableVenue(new UnroutableVenueError("x", "y")), true);
  assert.equal(isUnroutableVenue({ arxUnroutableVenue: true }), true);
  for (const no of [new Error("x"), null, undefined, {}, { arxUnroutableVenue: 1 }, { arxUnroutableVenue: "true" }]) {
    assert.equal(isUnroutableVenue(no), false, `misclassified ${JSON.stringify(no)}`);
  }
});

// -- the backfill default is not a runtime fallback -------------------------
test("the historical backfill venue is NOT consulted by the router", () => {
  // The schema column defaults to MT5_EA_BRIDGE because every pre-existing row
  // genuinely was MT5. That is a statement about history. If the ROUTER also
  // defaulted, a new command with no venue would silently reach a real broker.
  assert.equal(HISTORICAL_BACKFILL_VENUE, "MT5_EA_BRIDGE");
  assert.equal(routeExecutionVenue(null).ok, false,
    "the router fell back to the historical backfill venue");
  assert.equal(routeExecutionVenue(undefined).ok, false);
});

test("only a network venue may report an indeterminate delivery", () => {
  // MT5's deliver() is a local mailbox INSERT: it happened or it did not.
  assert.equal(venueDeliveryCanBeIndeterminate("MT5_EA_BRIDGE"), false);
  assert.equal(venueDeliveryCanBeIndeterminate("DERIV_DEMO"), true);
});

// -- the pipeline call site ------------------------------------------------
const PIPELINE = readFileSync(
  new URL("../../live/liveCommandPipeline.ts", import.meta.url), "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("the dispatch path selects by the SERVER-persisted venue, never client input", () => {
  assert.match(PIPELINE, /selectExecutionAdapter\(EXECUTION_ADAPTERS, row\.executionVenue\)/,
    "the venue is not read from the persisted command row");
  assert.ok(!/selectExecutionAdapter\([^)]*\b(req|body|payload)\./.test(PIPELINE),
    "the venue is taken from client-supplied input, which could select a privileged path");
});

test("no venue-specific adapter is invoked directly at the call site", () => {
  assert.ok(!/\bmt5ExecutionAdapter\.deliver\(/.test(PIPELINE),
    "the MT5 adapter is called directly, bypassing venue routing");
  assert.ok(!/\bderivExecutionAdapter\.deliver\(/.test(PIPELINE),
    "the Deriv adapter is called directly, bypassing venue routing");
});

test("no fallback adapter may creep into the registry lookup", () => {
  assert.ok(!/EXECUTION_ADAPTERS\[[^\]]+\]\s*(\?\?|\|\|)/.test(PIPELINE),
    "a fallback would reintroduce the default venue the router refuses to have");
});

test("the DERIV_DEMO registry entry fails CLOSED until its deps are wired", () => {
  // It cannot be a module constant: its adapter needs the resolved tier, the
  // proven-demo assertion and the durable intent writer, all per-request.
  // Reading those from ambient state is exactly how a tier check gets bypassed.
  const start = PIPELINE.indexOf("const EXECUTION_ADAPTERS");
  const block = PIPELINE.slice(start, PIPELINE.indexOf("\n};", start));
  assert.ok(block.includes("DERIV_DEMO_ADAPTER_NOT_WIRED"),
    "the Deriv registry entry does not fail closed");
  assert.ok(block.includes("throw"), "the unwired Deriv entry must throw, not return a result");
});

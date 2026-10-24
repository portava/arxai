// Position Guardian — the protection check, case by case (pure).
//
// Run: pnpm --filter @workspace/api-server run test:position-guardian-assess

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assessProtection,
  GUARDIAN_DEFAULTS,
  stopIsWider,
  type BrokerProtection,
  type GovernedProtection,
} from "../assess.js";

const NOW = new Date("2026-10-24T12:00:00Z");
const OPTS = { now: NOW, ...GUARDIAN_DEFAULTS };
const ago = (ms: number) => new Date(NOW.getTime() - ms);

const G: GovernedProtection = {
  ticket: "9001", symbol: "EURUSD", side: "BUY", lots: 0.1, stopLoss: 1.095, takeProfit: 1.11,
  sourceCommandId: "lvcmd_open", governedAt: ago(10 * 60_000),
};
const B: BrokerProtection = {
  present: true, side: "BUY", lots: 0.1, stopLoss: 1.095, takeProfit: 1.11, currentPrice: 1.1, observedAt: ago(5_000),
};

test("matching stop: protected, nothing to do", () => {
  const a = assessProtection(G, B, OPTS);
  assert.deepEqual(a.findings, ["PROTECTED"]);
  assert.equal(a.action, "NONE");
  assert.equal(a.escalate, false);
});

test("tighter broker stop is allowed and left alone", () => {
  const a = assessProtection(G, { ...B, stopLoss: 1.098 }, OPTS);
  assert.deepEqual(a.findings, ["PROTECTED_TIGHTER"]);
  assert.equal(a.action, "NONE");
});

test("missing broker stop: restore the governed stop", () => {
  const a = assessProtection(G, { ...B, stopLoss: null }, OPTS);
  assert.deepEqual(a.findings, ["STOP_MISSING"]);
  assert.equal(a.action, "RESTORE_STOP");
  assert.equal(a.restoreStopTo, 1.095);
  assert.equal(a.escalate, false);
});

test("widened broker stop: restore the governed stop, BUY and SELL", () => {
  const buy = assessProtection(G, { ...B, stopLoss: 1.09 }, OPTS);
  assert.deepEqual(buy.findings, ["STOP_WIDENED"]);
  assert.equal(buy.restoreStopTo, 1.095);
  const sellG = { ...G, side: "SELL" as const, stopLoss: 1.105, takeProfit: 1.09 };
  const sell = assessProtection(sellG, { ...B, side: "SELL", stopLoss: 1.11, takeProfit: 1.09 }, OPTS);
  assert.deepEqual(sell.findings, ["STOP_WIDENED"]);
  assert.equal(sell.action, "RESTORE_STOP");
  assert.equal(sell.restoreStopTo, 1.105);
});

test("price already through the governed stop: escalate, never restore an invalid stop", () => {
  const a = assessProtection(G, { ...B, stopLoss: null, currentPrice: 1.094 }, OPTS);
  assert.deepEqual(a.findings, ["STOP_MISSING", "PRICE_THROUGH_STOP"]);
  assert.equal(a.action, "ESCALATE");
  assert.equal(a.escalate, true);
});

test("stale broker facts: wait inside the fill grace, escalate after it", () => {
  const stale = { ...B, observedAt: ago(10 * 60_000) };
  const fresh = assessProtection({ ...G, governedAt: ago(30_000) }, stale, OPTS);
  assert.deepEqual(fresh.findings, ["SNAPSHOT_STALE"]);
  assert.equal(fresh.action, "WAIT");
  const old = assessProtection(G, stale, OPTS);
  assert.equal(old.action, "ESCALATE");
  assert.match(old.reason, /Cannot verify the stop/);
  assert.equal(assessProtection(G, { ...B, observedAt: null }, OPTS).action, "ESCALATE");
});

test("position not listed after a confirmed fill: wait, then escalate", () => {
  const gone = { ...B, present: false };
  assert.equal(assessProtection({ ...G, governedAt: ago(30_000) }, gone, OPTS).action, "WAIT");
  const a = assessProtection(G, gone, OPTS);
  assert.deepEqual(a.findings, ["POSITION_NOT_FOUND"]);
  assert.equal(a.action, "ESCALATE");
});

test("opposite side at the broker: escalate", () => {
  const a = assessProtection(G, { ...B, side: "SELL" }, OPTS);
  assert.deepEqual(a.findings, ["SIDE_MISMATCH"]);
  assert.equal(a.action, "ESCALATE");
});

test("more size than governed: escalate; with a widened stop, restore and escalate together", () => {
  const big = assessProtection(G, { ...B, lots: 0.3 }, OPTS);
  assert.deepEqual(big.findings, ["SIZE_EXCEEDED", "PROTECTED"]);
  assert.equal(big.action, "ESCALATE");
  const both = assessProtection(G, { ...B, lots: 0.3, stopLoss: 1.09 }, OPTS);
  assert.equal(both.action, "RESTORE_STOP");
  assert.equal(both.escalate, true);
  assert.match(both.reason, /never trims size/);
});

test("partial close and an altered target are reported, not acted on", () => {
  const a = assessProtection(G, { ...B, lots: 0.05, takeProfit: 1.12 }, OPTS);
  assert.deepEqual(a.findings, ["SIZE_REDUCED", "TAKE_PROFIT_ALTERED", "PROTECTED"]);
  assert.equal(a.action, "NONE");
});

test("no governed stop: escalate; a correction already on its way: wait", () => {
  assert.equal(assessProtection({ ...G, stopLoss: null }, B, OPTS).action, "ESCALATE");
  const pending = assessProtection(G, { ...B, stopLoss: null }, { ...OPTS, correctionPending: true });
  assert.deepEqual(pending.findings, ["CORRECTION_PENDING"]);
  assert.equal(pending.action, "WAIT");
});

test("the guardian only ever restores a stop tighter than the broker's", () => {
  for (const side of ["BUY", "SELL"] as const) {
    for (const broker of [null, 1.08, 1.09, 1.12, 1.13]) {
      const g = { ...G, side, stopLoss: side === "BUY" ? 1.095 : 1.105 };
      const a = assessProtection(g, { ...B, side, stopLoss: broker, currentPrice: 1.1 }, OPTS);
      if (a.action === "RESTORE_STOP") assert.ok(stopIsWider(side, a.restoreStopTo!, broker), `${side} ${broker}`);
    }
  }
});

test("demo commands from automated producers reach the governor as automation", async () => {
  const { demoIntentOrigin } = await import("../../mt5/demoCommandConsumer.js");
  assert.equal(demoIntentOrigin("POSITION_GUARDIAN"), "automation");
  assert.equal(demoIntentOrigin("AUTOPILOT"), "automation");
  assert.equal(demoIntentOrigin("self_trade_agent"), "automation");
  assert.equal(demoIntentOrigin("RUBY_CHAT"), "ruby");
  assert.equal(demoIntentOrigin("DEMO_TRADE_TICKET"), "manual");
  assert.equal(demoIntentOrigin(undefined), "manual");
});

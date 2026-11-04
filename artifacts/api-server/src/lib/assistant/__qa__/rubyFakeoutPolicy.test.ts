// Bounded fakeout SL/TP shift policy (rubyFakeoutPolicy.ts) — pure tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FAKEOUT_ADJUST_COOLDOWN_MS, FAKEOUT_MAX_ADJUSTMENTS, FAKEOUT_MAX_SL_WIDEN_RATIO,
  decideFakeoutAdjustment, isAdverseFakeout, type FakeoutDecisionInput,
} from "../rubyFakeoutPolicy.js";
import { emptyMonitorState, parseMonitorState, recordFakeoutAdjustment, serializeMonitorState, setFakeoutAuthority } from "../rubyMonitorPolicy.js";

const now = Date.parse("2026-11-04T10:00:00Z");
// Long position: entry 1.1000, stop 1.0950 (risk 50 pips), TP 1.1100.
// Last completed bar spiked down to 1.0940 (through the stop zone) and closed back up.
const spikeDownBar = { o: 1.0990, h: 1.0995, l: 1.0940, c: 1.0992 };
const base: FakeoutDecisionInput = {
  side: "BUY", entryPrice: 1.1000, currentPrice: 1.0992, stopLoss: 1.0950, takeProfit: 1.1100,
  lastBar: spikeDownBar, fakeoutRiskScore: 90, reversalRiskScore: 30, reversalThreshold: 65,
  atOrThroughStop: false, adjustmentsSoFar: 0, lastAdjustAt: null, nowMs: now,
};

test("isAdverseFakeout: long wick against the position that closed back, with no standing reversal evidence", () => {
  assert.equal(isAdverseFakeout(base).yes, true);
  assert.equal(isAdverseFakeout({ ...base, fakeoutRiskScore: 40 }).yes, false);
  assert.equal(isAdverseFakeout({ ...base, reversalRiskScore: 70 }).yes, false);
  assert.equal(isAdverseFakeout({ ...base, lastBar: { ...spikeDownBar, c: 1.0960 } }).yes, false); // closed against
  assert.equal(isAdverseFakeout({ ...base, lastBar: null }).yes, false);
});

test("SHIFT_SL: the stop inside the wick moves beyond the wick extreme, capped at 50% of the original risk", () => {
  const d = decideFakeoutAdjustment(base);
  assert.equal(d.action, "SHIFT_SL");
  // wanted = 1.0940 - 10% of range(0.0055)=0.00055 → 1.09345; cap = stop - 0.5*0.005 = 1.0925 → wanted is within cap
  assert.equal(d.newStopLoss, 1.09345);
  assert.equal(d.newTakeProfit, null);
  assert.match(d.reason, /moved to 1.09345/);
});

test("SHIFT_SL cap: a deep wick cannot widen the stop beyond the ratio of the original risk", () => {
  const d = decideFakeoutAdjustment({ ...base, lastBar: { o: 1.0990, h: 1.0995, l: 1.0800, c: 1.0992 } });
  assert.equal(d.action, "SHIFT_SL");
  const cap = 1.0950 - 0.005 * FAKEOUT_MAX_SL_WIDEN_RATIO;
  assert.equal(d.newStopLoss, Number(cap.toFixed(5)));
});

test("no shift when the stop is already clear of the wick, or price is at/through the stop", () => {
  assert.equal(decideFakeoutAdjustment({ ...base, stopLoss: 1.0900 }).action, "NONE");
  assert.equal(decideFakeoutAdjustment({ ...base, atOrThroughStop: true }).action, "NONE");
});

test("limits: at most two adjustments per monitor and one per cooldown", () => {
  assert.equal(decideFakeoutAdjustment({ ...base, adjustmentsSoFar: FAKEOUT_MAX_ADJUSTMENTS }).action, "NONE");
  const recent = new Date(now - FAKEOUT_ADJUST_COOLDOWN_MS / 2).toISOString();
  assert.equal(decideFakeoutAdjustment({ ...base, adjustmentsSoFar: 1, lastAdjustAt: recent }).action, "NONE");
  const old = new Date(now - FAKEOUT_ADJUST_COOLDOWN_MS * 2).toISOString();
  assert.equal(decideFakeoutAdjustment({ ...base, adjustmentsSoFar: 1, lastAdjustAt: old }).action, "SHIFT_SL");
});

test("SHIFT_TP: a favourable spike that nearly reached the target and failed brings the target in; never widened", () => {
  // Short position: entry 1.1000, TP 1.0900, stop 1.1050. Bar spiked down to 1.0905 (within 15% of target) and closed back at 1.0980.
  const d = decideFakeoutAdjustment({
    ...base, side: "SELL", entryPrice: 1.1000, currentPrice: 1.0980, stopLoss: 1.1050, takeProfit: 1.0900,
    lastBar: { o: 1.0985, h: 1.0990, l: 1.0905, c: 1.0980 }, fakeoutRiskScore: 10,
  });
  assert.equal(d.action, "SHIFT_TP");
  assert.ok(d.newTakeProfit! > 1.0905 && d.newTakeProfit! < 1.0980, `tightened TP ${d.newTakeProfit}`);
  // A spike that went THROUGH the target is not a "nearly": no change.
  const through = decideFakeoutAdjustment({
    ...base, side: "SELL", entryPrice: 1.1000, currentPrice: 1.0980, stopLoss: 1.1050, takeProfit: 1.0900,
    lastBar: { o: 1.0985, h: 1.0990, l: 1.0890, c: 1.0980 }, fakeoutRiskScore: 10,
  });
  assert.equal(through.action, "NONE");
});

test("sell side SL shift mirrors the buy rule", () => {
  const d = decideFakeoutAdjustment({
    ...base, side: "SELL", entryPrice: 1.1000, currentPrice: 1.1008, stopLoss: 1.1050, takeProfit: 1.0900,
    lastBar: { o: 1.1010, h: 1.1060, l: 1.1005, c: 1.1008 }, fakeoutRiskScore: 90,
  });
  assert.equal(d.action, "SHIFT_SL");
  assert.ok(d.newStopLoss! > 1.1060 && d.newStopLoss! <= 1.1050 + 0.005 * FAKEOUT_MAX_SL_WIDEN_RATIO);
});

test("monitor state carries the per-monitor fakeout authority and adjustments across serialize/parse", () => {
  let s = setFakeoutAuthority(emptyMonitorState(), true);
  s = recordFakeoutAdjustment(s, { at: "2026-11-04T10:00:00Z", price: 1.0992, fakeoutRiskScore: 90, fromStopLoss: 1.095, toStopLoss: 1.09345, fromTakeProfit: 1.11, toTakeProfit: null, reason: "r", ok: true, blocked: null });
  const back = parseMonitorState(serializeMonitorState(s));
  assert.equal(back.fakeoutAuthority, true);
  assert.equal(back.fakeoutAdjustments.length, 1);
  assert.equal(back.lastFakeoutAdjustAt, "2026-11-04T10:00:00Z");
  // A refused attempt is recorded but does not start the cooldown.
  const refused = recordFakeoutAdjustment(emptyMonitorState(), { at: "2026-11-04T11:00:00Z", price: null, fakeoutRiskScore: null, fromStopLoss: null, toStopLoss: null, fromTakeProfit: null, toTakeProfit: null, reason: "r", ok: false, blocked: "X" });
  assert.equal(refused.lastFakeoutAdjustAt, null);
  // Old rows without the field default to no authority.
  assert.equal(parseMonitorState(JSON.stringify({ monitor: { alertsSinceAck: 1 } })).fakeoutAuthority, false);
});

// Sweep 2026-11-04: the widening cap is measured from the ORIGINAL stop, so a
// second shift cannot add another half-risk on top of the first.
test("SHIFT_SL cap does not compound across adjustments when the original stop is known", () => {
  const deepBar = { o: 1.0990, h: 1.0995, l: 1.0800, c: 1.0992 };
  // First shift from the original stop 1.0950: capped at 1.0950 - 0.0025 = 1.0925.
  const first = decideFakeoutAdjustment({ ...base, lastBar: deepBar, originalStopLoss: 1.0950 });
  assert.equal(first.action, "SHIFT_SL");
  assert.equal(first.newStopLoss, 1.0925);
  // Second deep wick, stop now at 1.0925. Without the original stop the cap
  // would allow 1.0925 - 0.00375 = 1.08875; with it, the allowance is used up.
  const compounding = decideFakeoutAdjustment({ ...base, lastBar: deepBar, stopLoss: 1.0925, adjustmentsSoFar: 1 });
  assert.equal(compounding.action, "SHIFT_SL", "legacy behaviour without the original stop");
  assert.ok(compounding.newStopLoss! < 1.0925 - 0.0025 + 1e-9);
  const bounded = decideFakeoutAdjustment({ ...base, lastBar: deepBar, stopLoss: 1.0925, adjustmentsSoFar: 1, originalStopLoss: 1.0950 });
  assert.equal(bounded.action, "NONE");
  assert.match(bounded.reason, /cap from the original stop/);
});

test("SHIFT_SL rounds to the symbol's digits", () => {
  const gold = decideFakeoutAdjustment({
    side: "BUY", entryPrice: 2400, currentPrice: 2399.2, stopLoss: 2395, takeProfit: 2420,
    lastBar: { o: 2399, h: 2399.5, l: 2393.777, c: 2399.3 }, fakeoutRiskScore: 90, reversalRiskScore: 30, reversalThreshold: 65,
    atOrThroughStop: false, adjustmentsSoFar: 0, lastAdjustAt: null, nowMs: now, digits: 2, originalStopLoss: 2395,
  });
  assert.equal(gold.action, "SHIFT_SL");
  assert.equal(gold.newStopLoss, Number(gold.newStopLoss!.toFixed(2)));
});

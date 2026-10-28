// A CRITICAL event 20 hours away must not be described as an active window.
//
// scoreNewsRisk labels any CRITICAL event in the -2h…+24h look-around as
// NO_TRADE_WINDOW and blocks trade-plan validation for it (ARX's critical-event
// hold — that gate is kept). But the copy said "Event in 1200m … Trading
// blocked for this symbol while the no-trade window is active." The release was
// 20 hours away; the radar/Truth path called the same event UPCOMING. The copy
// must say what is actually happening: a hold ahead of a release that is not
// due yet, and when it is due.
// Run: pnpm --filter @workspace/api-server run test:truth-component-evidence

import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreNewsRisk, type EconomicEventInput } from "../index.js";

const NOW = Date.parse("2026-10-28T12:00:00.000Z");

function critical(minutesFromNow: number): EconomicEventInput {
  return {
    id: 7, eventName: "FOMC Rate Decision", currency: "USD", impactLevel: "CRITICAL",
    eventTimeIso: new Date(NOW + minutesFromNow * 60_000).toISOString(),
  };
}

test("CRITICAL event 20h ahead: hold kept, but nothing claims the window is active now", () => {
  const r = scoreNewsRisk({ symbol: "EURUSD", events: [critical(20 * 60)], nowMs: NOW });
  // The gate is not weakened.
  assert.equal(r.riskLevel, "NO_TRADE_WINDOW");
  assert.equal(r.blockTrading, true);
  assert.equal(r.timeUntilEventMinutes, 1200);
  const copy = [r.tradeWarning ?? "", r.aiSummary, ...r.reasons].join(" | ");
  assert.doesNotMatch(copy, /window is active/i);
  assert.doesNotMatch(copy, /no-trade window enforced/i);
  assert.doesNotMatch(copy, /1200m/);
  assert.match(r.tradeWarning ?? "", /in 20h 0m/);
  assert.match(r.tradeWarning ?? "", /not due for 20h 0m/);
  assert.match(r.tradeWarning ?? "", /24 hours before a critical event until 2 hours after/);
});

test("CRITICAL event released 45m ago: says when it was released and when the hold ends", () => {
  const r = scoreNewsRisk({ symbol: "EURUSD", events: [critical(-45)], nowMs: NOW });
  assert.equal(r.riskLevel, "NO_TRADE_WINDOW");
  assert.doesNotMatch(r.tradeWarning ?? "", /window is active/i);
  assert.match(r.tradeWarning ?? "", /45m ago/);
  assert.match(r.tradeWarning ?? "", /released 45m ago/);
});

test("CRITICAL event 5 minutes away is described as the live release window", () => {
  const r = scoreNewsRisk({ symbol: "EURUSD", events: [critical(5)], nowMs: NOW });
  assert.equal(r.riskLevel, "NO_TRADE_WINDOW");
  assert.equal(r.blockTrading, true);
  assert.match(r.tradeWarning ?? "", /no-trade window is active/);
});

test("HIGH event 10m away keeps the 15-minute window copy", () => {
  const r = scoreNewsRisk({
    symbol: "EURUSD", nowMs: NOW,
    events: [{ ...critical(10), impactLevel: "HIGH", eventName: "CPI" }],
  });
  assert.equal(r.riskLevel, "NO_TRADE_WINDOW");
  assert.match(r.tradeWarning ?? "", /no-trade window is active/);
});

// This scorer's blockTrading is read only by trade-plan validation
// (routes/tradePlans.ts) and the news alert. Orders placed outside a trade
// plan go through the trading-path news gate (lib/news/calendar/
// newsRiskScorer.ts), which blocks only around the release itself — so the
// copy must not say "ARX holds new trades on EURUSD" for 24 hours.
test("CRITICAL hold copy names what it holds (trade-plan validation), not all new trades", () => {
  for (const minutes of [20 * 60, -45]) {
    const r = scoreNewsRisk({ symbol: "EURUSD", events: [critical(minutes)], nowMs: NOW });
    assert.equal(r.blockTrading, true, "the trade-plan hold itself is kept");
    const copy = [r.tradeWarning ?? "", r.aiSummary, ...r.reasons].join(" | ");
    assert.doesNotMatch(copy, /holds new trades/i);
    assert.match(r.tradeWarning ?? "", /trade plan/i);
    assert.match(r.tradeWarning ?? "", /not held by this check/i);
    assert.doesNotMatch(r.tradeWarning ?? "", /^NO TRADE WINDOW:/, "a plan hold 20h out is not a live no-trade window");
    assert.ok(r.reasons.some((x) => /trade plan/i.test(x)), r.reasons.join(" | "));
  }
});

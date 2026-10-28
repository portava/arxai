// Trading Readiness score: a check that was never run earns no points, and the
// calendar check is named for what it reads.
//
// The score added WARN × 0.5, and the broker ("no broker health check on
// record"), market and news items are WARN "not checked" when nothing was
// observed — so about 17 of 100 points came from three checks that did not
// happen. "Market conditions acceptable: PASS — NORMAL (0 HIGH, 0 CRITICAL
// upcoming)" was read from the stored economic calendar only: no volatility,
// spread or price data.
//
// Calls the REAL evaluator; no database, broker or network is touched.

import { test } from "node:test";
import assert from "node:assert/strict";

const { evaluateReadiness } = await import("../tradingReadiness.js");

type Signals = Parameters<typeof evaluateReadiness>[0];
const INPUT = {
  mentalState: 4, sleepQuality: 4, stressLevel: 2, confidenceLevel: 4,
  strategyReady: true, riskRulesConfirmed: true,
};
function brokerLog(status: string, ageMs: number): Signals["brokerLog"] {
  return {
    id: 1, userId: null, brokerName: "MT5", status, latencyMs: 10, priceFeedDelayMs: null,
    lastHeartbeatAt: new Date(Date.now() - ageMs), errorCode: null, errorMessage: null,
    reconnectAttempts: 0, executionEnabled: true, reasons: [], warnings: [], blockers: [],
    createdAt: new Date(Date.now() - ageMs),
  } as Signals["brokerLog"];
}
function signals(opts: { brokerLog: Signals["brokerLog"]; calendarCovered: boolean }): Signals {
  return {
    safety: { killSwitchEngaged: false, operationalMode: "LIVE" },
    emergencyStopEngaged: false, activeLocks: [], brokerLog: opts.brokerLog, upcomingNews: [],
    activeContract: { contractName: "Core rules", maxTradesPerDay: 3, maxDailyLossPercent: 2, maxRiskPerTradePercent: 1 },
    recentReview: { weekStart: new Date(Date.now() - 3 * 86400_000) },
    calendarCoverage: {
      providerConfigured: true, storedEventCount: opts.calendarCovered ? 10 : 0,
      coveredThrough: opts.calendarCovered ? new Date(Date.now() + 3 * 3600_000).toISOString() : null,
      windowEnd: new Date(Date.now() + 2 * 3600_000).toISOString(), windowCovered: opts.calendarCovered,
      note: opts.calendarCovered ? null : "The stored economic calendar is empty (events have never been synced), so upcoming events cannot be ruled out.",
    },
  } as unknown as Signals;
}

test("checks that were not run (no broker check, calendar not covering 2h) earn no points", () => {
  const out = evaluateReadiness(signals({ brokerLog: null, calendarCovered: false }), INPUT);
  const byId = Object.fromEntries(out.checklist.map((c) => [c.id, c]));
  for (const id of ["broker", "market", "news"]) {
    assert.equal(byId[id]!.status, "WARN", `${id} is a warning, not a pass`);
    assert.match(byId[id]!.detail, /not checked|has not been checked/i, `${id} says it was not checked`);
  }
  const passes = out.checklist.filter((c) => c.status === "PASS").length;
  assert.equal(passes, 6);
  assert.equal(out.score, Math.round((passes / out.checklist.length) * 100),
    "only the six checks that passed score; the three unchecked ones add nothing");
});

test("a broker verdict too old to count earns no points either", () => {
  const out = evaluateReadiness(signals({ brokerLog: brokerLog("CONNECTED", 3 * 86400_000), calendarCovered: true }), INPUT);
  const passes = out.checklist.filter((c) => c.status === "PASS").length;
  assert.equal(passes, out.checklist.length - 1);
  assert.equal(out.score, Math.round((passes / out.checklist.length) * 100));
});

test("a warning from something that WAS observed still earns half credit", () => {
  const out = evaluateReadiness(signals({ brokerLog: brokerLog("CONNECTED", 20_000), calendarCovered: true }),
    { ...INPUT, strategyReady: false });
  assert.equal(out.checklist.find((c) => c.id === "strategy")!.status, "WARN");
  const n = out.checklist.length;
  assert.equal(out.score, Math.round(((n - 1 + 0.5) / n) * 100));
});

test("the calendar check is named for the economic calendar, not as a market-conditions check", () => {
  const out = evaluateReadiness(signals({ brokerLog: brokerLog("CONNECTED", 20_000), calendarCovered: true }), INPUT);
  const market = out.checklist.find((c) => c.id === "market")!;
  assert.equal(market.status, "PASS");
  assert.doesNotMatch(market.label, /market conditions/i);
  assert.match(market.label, /economic/i);
  assert.match(market.detail, /economic calendar/i);
  assert.match(market.detail, /volatility, spreads and prices are not checked/i);
  assert.doesNotMatch(market.detail, /\bNORMAL\b/, "no market-condition verdict from a calendar read");
});

test("the NOT_READY summary names the items that actually failed", () => {
  const s = signals({ brokerLog: brokerLog("CONNECTED", 20_000), calendarCovered: true });
  const out = evaluateReadiness({ ...s, activeContract: null } as Signals, INPUT);
  assert.equal(out.status, "NOT_READY");
  const failed = out.checklist.filter((c) => c.status === "FAIL").map((c) => c.label);
  assert.deepEqual(failed, ["Trading rules confirmed", "Risk limit confirmed"]);
  for (const label of failed) assert.ok(out.aiSummary.includes(label), `summary names "${label}": ${out.aiSummary}`);
  assert.doesNotMatch(out.aiSummary, /mental check-in|broker|news/i, "items that passed are not listed as failed");
});

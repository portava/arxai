// Trading Readiness "Broker connected" is never PASS on an old snapshot.
//
// The broker check read the newest broker_health_logs row — a platform-wide
// snapshot written only when an operator POSTs /broker/health-check — with no
// age check, so a CONNECTED snapshot from days ago scored "Broker connected
// PASS" after the EA had stopped. With no row at all the warning said "last
// heartbeat missing", which misdescribes "no broker health check on record".
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
function signals(brokerLog: Signals["brokerLog"]): Signals {
  return {
    safety: { killSwitchEngaged: false, operationalMode: "LIVE" },
    emergencyStopEngaged: false, activeLocks: [], brokerLog, upcomingNews: [],
    activeContract: null, recentReview: null,
    // Calendar coverage is its own check; keep it covered so only the broker row varies.
    calendarCoverage: {
      providerConfigured: true, storedEventCount: 1, coveredThrough: new Date(Date.now() + 3 * 3600_000).toISOString(),
      windowEnd: new Date(Date.now() + 2 * 3600_000).toISOString(), windowCovered: true, note: null,
    },
  } as unknown as Signals;
}
function log(status: string, ageMs: number): Signals["brokerLog"] {
  return {
    id: 1, userId: null, brokerName: "MT5", status, latencyMs: 10, priceFeedDelayMs: null,
    lastHeartbeatAt: new Date(Date.now() - ageMs), errorCode: null, errorMessage: null,
    reconnectAttempts: 0, executionEnabled: true, reasons: [], warnings: [], blockers: [],
    createdAt: new Date(Date.now() - ageMs),
  } as Signals["brokerLog"];
}
const broker = (s: Signals) => evaluateReadiness(s, INPUT).checklist.find((c) => c.id === "broker")!;

test("a CONNECTED snapshot from 3 days ago is not 'Broker connected PASS'", () => {
  const item = broker(signals(log("CONNECTED", 3 * 24 * 3600_000)));
  assert.notEqual(item.status, "PASS");
  assert.match(item.detail, /too old/i);
  assert.match(item.detail, /CONNECTED/);
  const out = evaluateReadiness(signals(log("CONNECTED", 3 * 24 * 3600_000)), INPUT);
  assert.notEqual(out.brokerStatus, "CONNECTED", "a stale snapshot's status is not reported as the broker status now");
});

test("a fresh CONNECTED snapshot passes and says which check it came from and when", () => {
  const item = broker(signals(log("CONNECTED", 20_000)));
  assert.equal(item.status, "PASS");
  assert.match(item.detail, /platform broker health check/i);
  assert.match(item.detail, /\d+s ago/);
});

test("a stale DISCONNECTED snapshot still fails (never weakened by age)", () => {
  const out = evaluateReadiness(signals(log("DISCONNECTED", 3 * 24 * 3600_000)), INPUT);
  assert.equal(out.checklist.find((c) => c.id === "broker")!.status, "FAIL");
  assert.equal(out.status, "LOCKED");
});

test("no snapshot at all says no broker health check is on record, not 'last heartbeat missing'", () => {
  const out = evaluateReadiness(signals(null), INPUT);
  const item = out.checklist.find((c) => c.id === "broker")!;
  assert.equal(item.status, "WARN");
  for (const text of [item.detail, ...out.warnings]) assert.doesNotMatch(text, /last heartbeat missing/i);
  assert.match(item.detail, /no broker health check/i);
});

// A broker health verdict is not "not connected" unless it says DISCONNECTED.
// EXECUTION_DISABLED (the schema default while live trading is off) and
// DEGRADED are written only while the MT5 heartbeat is under 60 s old, so the
// link was up; PRICE_FEED_DELAYED likewise. Readiness said "Broker not
// connected (EXECUTION_DISABLED)" and LOCKED, with no age on the blocker.
//
// The wording is fixed, but the verdict stays as strict as it was: the stored
// readiness status is read by tradeDecision.orchestrate() (LOCKED/NOT_READY is
// a blocker that forces HOLD) and through it by the paper autopilot, so these
// statuses still LOCK readiness, fresh or stale, exactly as before.
for (const status of ["EXECUTION_DISABLED", "DEGRADED"]) {
  test(`a fresh ${status} verdict is not 'Broker not connected', and still locks readiness as before`, () => {
    const out = evaluateReadiness(signals(log(status, 20_000)), INPUT);
    const item = out.checklist.find((c) => c.id === "broker")!;
    assert.doesNotMatch(item.detail, /not connected/i);
    for (const text of [...out.blockers, ...out.warnings, out.aiSummary]) assert.doesNotMatch(text, /not connected/i);
    assert.equal(item.status, "FAIL", "not ready for broker execution: the check does not pass");
    assert.match(item.detail, /connected/i);
    assert.match(item.detail, /\d+s ago/, "says when the check was made");
    assert.equal(out.status, "LOCKED", "the stored status an autopilot path reads is not loosened");
    assert.equal(out.brokerStatus, status);
    const blocker = out.blockers.find((b) => b.includes(status));
    assert.ok(blocker, "the verdict is a named blocker");
    assert.match(blocker!, /\d+s ago/);
  });

  test(`a stale ${status} verdict still locks readiness (age never weakens it) and says no newer check is on record`, () => {
    const out = evaluateReadiness(signals(log(status, 3 * 24 * 3600_000)), INPUT);
    assert.equal(out.status, "LOCKED");
    assert.equal(out.checklist.find((c) => c.id === "broker")!.status, "FAIL");
    assert.equal(out.brokerStatus, status);
    const blocker = out.blockers.find((b) => b.includes(status))!;
    assert.match(blocker, /3d ago — no newer check on record/);
  });
}

// executionEnabled starts false (the schema default) and may never have been
// switched on, so EXECUTION_DISABLED is the observed state of the switch, not
// an operator action anyone observed.
test("EXECUTION_DISABLED says broker execution was not enabled (switch off) and what that blocks, not that an operator turned it off", () => {
  const out = evaluateReadiness(signals(log("EXECUTION_DISABLED", 20_000)), INPUT);
  const item = out.checklist.find((c) => c.id === "broker")!;
  for (const text of [item.detail, ...out.blockers, ...out.warnings, out.aiSummary]) {
    assert.doesNotMatch(text, /turned off by the operator|operator (turned|switched|disabled)/i);
  }
  assert.match(item.detail, /broker execution was not enabled \(the operator execution switch was off\)/i);
  assert.match(item.detail, /DEMO or LIVE/);
  assert.ok(out.blockers.some((w) => /execution not enabled \(operator execution switch off\)/i.test(w)), "the blocker names the switch state");
});

// EXECUTION_DISABLED locks readiness again, and tradeDecision.orchestrate()
// turns a stored LOCKED into a blocker (HOLD), which the paper autopilot skips
// on. The detail still said "paper trading is not affected".
test("EXECUTION_DISABLED does not say paper trading is unaffected: the LOCKED check stops the paper autopilot", () => {
  const out = evaluateReadiness(signals(log("EXECUTION_DISABLED", 20_000)), INPUT);
  const item = out.checklist.find((c) => c.id === "broker")!;
  assert.equal(out.status, "LOCKED", "the lock is kept");
  assert.equal(item.status, "FAIL");
  assert.doesNotMatch(item.detail, /paper trading is not affected/i);
  assert.match(item.detail, /does not block manual paper orders/);
  assert.match(item.detail, /AI trade decision holds and the paper autopilot opens no trades/);
});

test("PRICE_FEED_DELAYED still blocks but says the feed was delayed, not that the broker was disconnected", () => {
  const out = evaluateReadiness(signals(log("PRICE_FEED_DELAYED", 20_000)), INPUT);
  const item = out.checklist.find((c) => c.id === "broker")!;
  assert.equal(item.status, "FAIL");
  assert.equal(out.status, "LOCKED");
  for (const text of [item.detail, ...out.blockers, out.aiSummary]) assert.doesNotMatch(text, /not connected/i);
  assert.ok(out.blockers.some((b) => /price feed delayed/i.test(b)));
  assert.notEqual(item.label, "Broker connected", "a FAIL here is not 'Broker connected: FAIL' — the link was up");
});

test("a blocker carries when the broker verdict was recorded", () => {
  const out = evaluateReadiness(signals(log("DISCONNECTED", 3 * 24 * 3600_000)), INPUT);
  const blocker = out.blockers.find((b) => /broker/i.test(b))!;
  assert.match(blocker, /not connected/i);
  assert.match(blocker, /3d ago/, "a days-old verdict says so");
});

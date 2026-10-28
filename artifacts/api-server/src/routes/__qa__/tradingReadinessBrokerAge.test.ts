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
for (const status of ["EXECUTION_DISABLED", "DEGRADED"]) {
  test(`a fresh ${status} verdict is not 'Broker not connected' and does not lock readiness on its own`, () => {
    const out = evaluateReadiness(signals(log(status, 20_000)), INPUT);
    const item = out.checklist.find((c) => c.id === "broker")!;
    assert.doesNotMatch(item.detail, /not connected/i);
    for (const text of [...out.blockers, ...out.warnings, out.aiSummary]) assert.doesNotMatch(text, /not connected/i);
    assert.equal(item.status, "WARN", "the link was up but not ready for broker execution: a warning, not a pass");
    assert.match(item.detail, /connected/i);
    assert.match(item.detail, /\d+s ago/, "says when the check was made");
    assert.notEqual(out.status, "LOCKED");
    assert.equal(out.blockers.length, 0);
  });
}

test("EXECUTION_DISABLED says the operator turned broker execution off and what that blocks", () => {
  const out = evaluateReadiness(signals(log("EXECUTION_DISABLED", 20_000)), INPUT);
  const item = out.checklist.find((c) => c.id === "broker")!;
  assert.match(item.detail, /execution was turned off by the operator/i);
  assert.match(item.detail, /DEMO or LIVE/);
  assert.ok(out.warnings.some((w) => /execution (was )?turned off/i.test(w)), "the warning names the operator switch");
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

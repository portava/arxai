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

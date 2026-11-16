// Truth regression: the Market Sessions clock must not report London / New
// York as OPEN (or the London/NY overlap as HIGH_VOLATILITY) while interbank
// FX is closed for the weekend.
//   node --import tsx --test src/lib/__qa__/sessionClockWeekend.test.ts

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { sessionClock } from "../marketDataLayer.js";

function at(ms: number): void {
  mock.timers.enable({ apis: ["Date"], now: ms });
}

test("Saturday 13:30 UTC → no active session, no overlap, CLOSED label", () => {
  at(Date.UTC(2026, 9, 31, 13, 30)); // Sat
  try {
    const c = sessionClock();
    assert.deepEqual(c.activeSessions, []);
    assert.equal(c.overlap, false);
    assert.equal(c.marketClosed, true);
    assert.equal(c.sessionLabel, "CLOSED");
    assert.ok(c.sessions.every((s) => !s.isActive));
    assert.doesNotMatch(c.recommendation, /overlap/i);
    assert.match(c.recommendation, /closed/i);
    // Next London open is Monday 07:00 UTC (41.5h away → 42 whole hours from the hour start), not "in 18h".
    const london = c.sessions.find((s) => s.id === "London")!;
    assert.ok(london.nextOpenInHours > 24, `London next open ${london.nextOpenInHours}h`);
  } finally {
    mock.timers.reset();
  }
});

test("Tuesday 14:00 UTC → London and New York open, overlap", () => {
  at(Date.UTC(2026, 9, 27, 14, 0)); // Tue
  try {
    const c = sessionClock();
    assert.deepEqual([...c.activeSessions].sort(), ["London", "NewYork"]);
    assert.equal(c.marketClosed, false);
    assert.equal(c.sessionLabel, "HIGH_VOLATILITY");
    const london = c.sessions.find((s) => s.id === "London")!;
    assert.equal(london.nextCloseInHours, 2);
    assert.equal(london.nextOpenInHours, 17);
  } finally {
    mock.timers.reset();
  }
});

test("Friday 21:30 UTC in EDT → New York closed by the 17:00 New York weekly close", () => {
  at(Date.UTC(2026, 9, 30, 21, 30)); // Fri, EDT → 17:30 New York
  try {
    const c = sessionClock();
    assert.equal(c.activeSessions.includes("NewYork"), false);
    assert.equal(c.marketClosed, true);
  } finally {
    mock.timers.reset();
  }
});

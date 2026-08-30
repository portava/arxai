// Market Sessions — the session clock must respect the trading WEEK.
//
// BEFORE
//   `inSession()` took only a UTC hour and `sessionClock()` read only
//   `getUTCHours()`. There was no day-of-week check anywhere. On a Saturday the
//   page therefore showed London and New York OPEN with an ACTIVE /
//   HIGH_VOLATILITY badge and advised "Good window for trend strategies" or
//   "heightened volatility around the London/NY overlap. Tighten stops." — while
//   FX and equity markets were shut. A trader waiting for the recommended
//   window was pointed at a closed market.
//
// AFTER
//   `isTradingWeekOpen` gates everything on the FX week (Sunday 21:00 UTC →
//   Friday 21:00 UTC), the clock reports MARKET_CLOSED with no active sessions,
//   and per-session "next open" becomes hours-until-the-week-reopens rather
//   than a meaningless hour-of-day delta.
//
// Run: node --import tsx --test src/lib/__qa__/marketSessionWeek.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  sessionClock,
  isTradingWeekOpen,
  hoursUntilTradingWeekOpen,
} from "../marketDataLayer.js";

/** 2026-08-29 is a Saturday; 2026-08-30 a Sunday; 2026-08-28 a Friday. */
const SATURDAY_1400 = new Date("2026-08-29T14:00:00.000Z");
const SUNDAY_1200 = new Date("2026-08-30T12:00:00.000Z");
const SUNDAY_2200 = new Date("2026-08-30T22:00:00.000Z");
const FRIDAY_1400 = new Date("2026-08-28T14:00:00.000Z");
const FRIDAY_2200 = new Date("2026-08-28T22:00:00.000Z");
const WEDNESDAY_1400 = new Date("2026-08-26T14:00:00.000Z");

test("the FX week is closed all Saturday", () => {
  assert.equal(SATURDAY_1400.getUTCDay(), 6, "fixture must actually be a Saturday");
  assert.equal(isTradingWeekOpen(SATURDAY_1400), false);
  assert.equal(isTradingWeekOpen(new Date("2026-08-29T02:00:00.000Z")), false);
  assert.equal(isTradingWeekOpen(new Date("2026-08-29T23:00:00.000Z")), false);
});

test("the FX week opens Sunday 21:00 UTC and closes Friday 21:00 UTC", () => {
  assert.equal(isTradingWeekOpen(SUNDAY_1200), false, "Sunday midday is still closed");
  assert.equal(isTradingWeekOpen(SUNDAY_2200), true, "Sunday 22:00 is open");
  assert.equal(isTradingWeekOpen(FRIDAY_1400), true, "Friday afternoon is open");
  assert.equal(isTradingWeekOpen(FRIDAY_2200), false, "Friday 22:00 is closed");
  assert.equal(isTradingWeekOpen(WEDNESDAY_1400), true);
});

test("Saturday 14:00 UTC no longer reports London/NY open", () => {
  const c = sessionClock(SATURDAY_1400);
  // 14:00 UTC is inside London (07-16) and New York (13-22) by hour alone —
  // this is exactly the hour that produced the false HIGH_VOLATILITY read.
  assert.deepEqual(c.activeSessions, [], "no session may be active with markets shut");
  assert.equal(c.sessionLabel, "MARKET_CLOSED");
  assert.equal(c.marketOpen, false);
  assert.equal(c.overlap, false);
  for (const s of c.sessions) {
    assert.equal(s.isActive, false, `${s.id} must not be OPEN on a Saturday`);
    assert.equal(s.nextCloseInHours, null, "a shut session has no next close");
  }
});

test("the weekend recommendation does not advise trading a shut market", () => {
  const c = sessionClock(SATURDAY_1400);
  assert.match(c.recommendation, /closed/i);
  assert.ok(!/Good window for trend strategies/.test(c.recommendation));
  assert.ok(!/Tighten stops/.test(c.recommendation));
});

test("the weekend clock says when the week reopens, in real hours", () => {
  const c = sessionClock(SATURDAY_1400);
  // Sat 14:00 → Sun 21:00 is 31 hours.
  assert.equal(c.weekOpensInHours, 31);
  assert.equal(hoursUntilTradingWeekOpen(SATURDAY_1400), 31);
  for (const s of c.sessions) {
    assert.equal(s.nextOpenInHours, 31, "every session reopens with the week");
  }
});

test("hoursUntilTradingWeekOpen is 0 while the week is open", () => {
  assert.equal(hoursUntilTradingWeekOpen(WEDNESDAY_1400), 0);
});

test("a mid-week hour still reads normally", () => {
  const c = sessionClock(WEDNESDAY_1400);
  assert.equal(c.marketOpen, true);
  assert.equal(c.weekOpensInHours, null);
  assert.deepEqual([...c.activeSessions].sort(), ["London", "NewYork"]);
  assert.equal(c.sessionLabel, "HIGH_VOLATILITY");
});

test("the session clock is not labelled as simulator output", () => {
  // The page carried a hardcoded "SIMULATOR" badge over what is a real UTC clock.
  assert.equal(sessionClock(WEDNESDAY_1400).dataSource, "SYSTEM_CLOCK_UTC");
});

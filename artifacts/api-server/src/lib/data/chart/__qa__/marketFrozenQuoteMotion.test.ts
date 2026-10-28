// QA — "Market closed — last quote …" must not be asserted from a stale broker
// clock alone. The EA sends brokerTimeEpochMs without any zone conversion, so a
// broker clock behind server UTC makes every tick look >5 min old even while
// the bid changes tick by tick. A market whose quote keeps MOVING is trading;
// only a quote that stays identical (bid + broker time) while ticks keep
// arriving is the closed-market replay the indicator describes.
//
// Run: node --import tsx --test --test-force-exit \
//   src/lib/data/chart/__qa__/marketFrozenQuoteMotion.test.ts

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { foldFormingTick, getFeedFreshness, __resetFormingBarStore } from "../formingBarComposer.js";

const now = Date.UTC(2026, 9, 26, 14, 2, 0); // Mon 14:02 UTC — market open
const BEHIND = 6 * 60_000; // broker clock 6 min behind server UTC

beforeEach(() => __resetFormingBarStore());

test("moving bid with a broker clock behind UTC is not called a closed market", () => {
  foldFormingTick("EURUSD", 1.1, now - 2_000 - BEHIND, now - 2_000, "mt5_broker");
  foldFormingTick("EURUSD", 1.1003, now - 1_000 - BEHIND, now - 1_000, "mt5_broker");
  foldFormingTick("EURUSD", 1.1005, now - BEHIND, now, "mt5_broker");
  const f = getFeedFreshness("EURUSD", now, "mt5_broker");
  assert.ok(f);
  assert.ok((f.brokerStaleMs ?? 0) > 5 * 60_000, "precondition: broker time reads >5 min old");
  assert.equal(f.marketFrozen, false, "prices are changing — this is not a closed market");
});

test("a quote that only replays (same bid, same broker time) while ticks arrive still reads frozen", () => {
  const brokerTime = now - 40 * 60_000;
  // First observation is already the replayed quote; replays keep arriving.
  for (let i = 10; i >= 0; i--) foldFormingTick("EURUSD", 1.1, brokerTime, now - i * 30_000, "mt5_broker");
  const f = getFeedFreshness("EURUSD", now, "mt5_broker");
  assert.ok(f);
  assert.equal(f.marketFrozen, true);
});

test("a market that stopped moving more than five minutes ago reads frozen again", () => {
  const brokerTime = now - 60 * 60_000;
  foldFormingTick("EURUSD", 1.1, brokerTime - 1_000, now - 20 * 60_000, "mt5_broker");
  foldFormingTick("EURUSD", 1.1002, brokerTime, now - 19 * 60_000, "mt5_broker"); // last real move
  for (let i = 18; i >= 0; i--) foldFormingTick("EURUSD", 1.1002, brokerTime, now - i * 60_000, "mt5_broker");
  assert.equal(getFeedFreshness("EURUSD", now, "mt5_broker")?.marketFrozen, true);
});

// A broker clock AHEAD of server UTC (the EA sends unconverted server time,
// e.g. UTC+3) makes brokerStaleMs clamp to 0, so a closed market replaying its
// last quote never read frozen. The clock-independent signal is the quote
// itself: identical bid + broker time replayed for more than five minutes
// while ticks keep arriving is the closed-market replay.
const AHEAD = 3 * 60 * 60_000; // broker clock 3 h ahead of server UTC

test("broker clock ahead of UTC: a quote replayed unchanged for 10 minutes reads frozen", () => {
  const brokerTime = now + AHEAD - 30 * 60_000; // frozen quote, stamped in the broker's future-looking clock
  for (let i = 20; i >= 0; i--) foldFormingTick("EURUSD", 1.1, brokerTime, now - i * 30_000, "mt5_broker");
  const f = getFeedFreshness("EURUSD", now, "mt5_broker");
  assert.ok(f);
  assert.equal(f.brokerStaleMs, 0, "precondition: the ahead clock cannot measure staleness");
  assert.equal(f.marketFrozen, true);
});

test("broker clock ahead of UTC: a moving quote is not called closed", () => {
  for (let i = 20; i >= 0; i--) {
    foldFormingTick("EURUSD", 1.1 + i * 0.0001, now + AHEAD - i * 30_000, now - i * 30_000, "mt5_broker");
  }
  assert.equal(getFeedFreshness("EURUSD", now, "mt5_broker")?.marketFrozen, false);
});

test("broker clock ahead of UTC: a replay seen for under five minutes is not yet called closed", () => {
  const brokerTime = now + AHEAD - 30 * 60_000;
  for (let i = 4; i >= 0; i--) foldFormingTick("EURUSD", 1.1, brokerTime, now - i * 60_000, "mt5_broker");
  assert.equal(getFeedFreshness("EURUSD", now, "mt5_broker")?.marketFrozen, false);
});

test("a feed that stopped arriving is never called closed, whatever the clock", () => {
  const brokerTime = now + AHEAD - 30 * 60_000;
  for (let i = 20; i >= 10; i--) foldFormingTick("EURUSD", 1.1, brokerTime, now - i * 60_000, "mt5_broker");
  assert.equal(getFeedFreshness("EURUSD", now, "mt5_broker")?.marketFrozen, false);
});

// Mood Patterns — the mood→outcome correlation is computed, not implied.
//
// BEFORE
//   `/api/me/mood/patterns` was documented as correlating mood with trade
//   outcomes and imported `paperTradesTable`, which was never referenced. The
//   response was a check-in histogram plus a canned sentence from three
//   hardcoded thresholds. The one useful output — which states cost this user
//   money — was never computed.
//
// AFTER
//   `correlateMoodOutcomes` joins CLOSED trades to the check-in the user made
//   before opening them, within a bounded window. A trade with no check-in near
//   it is reported as unattributed rather than folded in silently, and zero
//   attributable trades is an explicit unavailable state.
//
// Run: node --import tsx --test src/lib/__qa__/moodOutcomeCorrelation.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { correlateMoodOutcomes, MOOD_ATTRIBUTION_WINDOW_MS } from "../mood/moodOutcomeCorrelation.js";

const T0 = Date.parse("2026-08-20T10:00:00.000Z");
const h = (n: number) => new Date(T0 + n * 3_600_000);

test("a trade is attributed to the most recent check-in before it", () => {
  const out = correlateMoodOutcomes(
    [
      { mood: "CALM", checkedInAt: h(0) },
      { mood: "REVENGE", checkedInAt: h(2) },
    ],
    [{ openedAt: h(3), pnl: -50 }],
  );
  assert.equal(out.attributedTrades, 1);
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0]?.mood, "REVENGE", "the nearer check-in wins, not the first");
  assert.equal(out.rows[0]?.netPnl, -50);
});

test("a check-in AFTER the trade opened is never used", () => {
  const out = correlateMoodOutcomes(
    [{ mood: "CALM", checkedInAt: h(5) }],
    [{ openedAt: h(3), pnl: 20 }],
  );
  assert.equal(out.attributedTrades, 0);
  assert.equal(out.unattributedTrades, 1);
  assert.deepEqual(out.rows, []);
});

test("a check-in older than the window does not claim the trade", () => {
  const beyond = MOOD_ATTRIBUTION_WINDOW_MS / 3_600_000 + 1;
  const out = correlateMoodOutcomes(
    [{ mood: "CALM", checkedInAt: h(0) }],
    [{ openedAt: h(beyond), pnl: 10 }],
  );
  assert.equal(out.attributedTrades, 0, "a stale check-in says nothing about that trade");
  assert.equal(out.unattributedTrades, 1);
});

test("win rate and net P&L are real per-mood aggregates", () => {
  const out = correlateMoodOutcomes(
    [
      { mood: "FOMO", checkedInAt: h(0) },
      { mood: "FOCUSED", checkedInAt: h(10) },
    ],
    [
      { openedAt: h(1), pnl: -30 },
      { openedAt: h(2), pnl: -70 },
      { openedAt: h(3), pnl: 10 },
      { openedAt: h(11), pnl: 40 },
      { openedAt: h(12), pnl: 60 },
    ],
  );
  const fomo = out.rows.find((r) => r.mood === "FOMO");
  const focused = out.rows.find((r) => r.mood === "FOCUSED");
  assert.equal(fomo?.trades, 3);
  assert.equal(fomo?.wins, 1);
  assert.equal(fomo?.winRatePct, 33);
  assert.equal(fomo?.netPnl, -90);
  assert.equal(focused?.trades, 2);
  assert.equal(focused?.winRatePct, 100);
  assert.equal(focused?.netPnl, 100);
});

test("the worst mood sorts first — that is the end that matters", () => {
  const out = correlateMoodOutcomes(
    [
      { mood: "CALM", checkedInAt: h(0) },
      { mood: "REVENGE", checkedInAt: h(10) },
    ],
    [
      { openedAt: h(1), pnl: 100 },
      { openedAt: h(11), pnl: -200 },
    ],
  );
  assert.equal(out.rows[0]?.mood, "REVENGE");
});

test("no check-ins at all yields no rows and no invented zeroes", () => {
  const out = correlateMoodOutcomes([], [{ openedAt: h(1), pnl: 10 }]);
  assert.deepEqual(out.rows, []);
  assert.equal(out.attributedTrades, 0);
  assert.equal(out.unattributedTrades, 1);
});

test("a breakeven trade counts as a trade but not a win", () => {
  const out = correlateMoodOutcomes(
    [{ mood: "CALM", checkedInAt: h(0) }],
    [{ openedAt: h(1), pnl: 0 }],
  );
  assert.equal(out.rows[0]?.trades, 1);
  assert.equal(out.rows[0]?.wins, 0);
  assert.equal(out.rows[0]?.winRatePct, 0);
});

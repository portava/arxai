// Paper-session loss-limit UNITS.
//
// `paper_sessions.net_pnl` and `paper_session_trade_links.pnl` are integer
// CENTS columns. `SessionRules.maxSessionLoss` / `maxDailyPaperLoss` are
// DOLLARS (DEFAULT_RULES: 150 / 300). The shipped code compared them directly:
//
//     if (cur.netPnl <= -cur.sessionRules.maxSessionLoss)   // cents vs dollars
//
// so a $150 session stop-loss tripped at −$1.50 — a paper session was blocked
// on essentially the first losing trade — and the session report then printed
// "SESSION_LOSS_EXCEEDED limit 150 actual 15000", two numbers 100× apart on
// one line, above a coach summary that read "net $-150.00".
//
// These assertions fail if the conversion is removed from
// sessionLossLimitBreached (mutate it to `netPnlCents <= -maxSessionLossUsd`
// and the first four cases go red).
//
// Run: node --import tsx --test src/lib/paperSession/__qa__/sessionLossLimitUnits.test.ts

// These units are pure arithmetic, but they import through a module that pulls
// in @workspace/db, whose index throws at import time when DATABASE_URL is
// unset. Set a deliberately unreachable placeholder so the lane is
// self-contained in CI: nothing here opens a connection, and anything that
// tried would fail loudly rather than silently pass.
process.env["DATABASE_URL"] ??= "postgres://user:pass@127.0.0.1:1/nonexistent";

import { test } from "node:test";
import assert from "node:assert/strict";

// Dynamic import so the DATABASE_URL placeholder above is set BEFORE the
// module graph (which reaches @workspace/db) is evaluated — a static import
// is hoisted above the assignment and the lane dies at import time.
const {
  sessionLossLimitBreached, usdToCents, centsToUsd, DEFAULT_RULES,
} = await import("../manager.js");

test("the default session limit is 150 DOLLARS, not 150 cents", () => {
  assert.equal(DEFAULT_RULES.maxSessionLoss, 150);
  assert.equal(usdToCents(DEFAULT_RULES.maxSessionLoss), 15_000);
});

test("a $1.50 loss does NOT breach a $150 session limit (the shipped bug)", () => {
  // −$1.50 == −150 cents. The old comparison read this as "−150 <= −150" and
  // stopped the session.
  assert.equal(sessionLossLimitBreached(-150, DEFAULT_RULES.maxSessionLoss), false);
});

test("a $149.99 loss does not breach; $150.00 does; $150.01 does", () => {
  assert.equal(sessionLossLimitBreached(-14_999, 150), false);
  assert.equal(sessionLossLimitBreached(-15_000, 150), true);
  assert.equal(sessionLossLimitBreached(-15_001, 150), true);
});

test("a winning or flat session never breaches", () => {
  assert.equal(sessionLossLimitBreached(0, 150), false);
  assert.equal(sessionLossLimitBreached(25_000, 150), false);
});

test("a custom dollar limit converts the same way", () => {
  assert.equal(sessionLossLimitBreached(-4_999, 50), false);
  assert.equal(sessionLossLimitBreached(-5_000, 50), true);
});

test("fractional-dollar limits round to whole cents, never to a looser limit", () => {
  // $12.34 → 1234 cents exactly. Rounding must not widen the stop.
  assert.equal(usdToCents(12.34), 1234);
  assert.equal(sessionLossLimitBreached(-1_233, 12.34), false);
  assert.equal(sessionLossLimitBreached(-1_234, 12.34), true);
});

test("the report's dollar figure and the limit are now on the same scale", () => {
  const netPnlCents = -15_231;              // −$152.31
  assert.equal(sessionLossLimitBreached(netPnlCents, 150), true);
  const actualUsd = Number((-centsToUsd(netPnlCents)).toFixed(2));
  assert.equal(actualUsd, 152.31);
  // The pair a reader sees: limit 150, actual 152.31 — same unit, comparable.
  assert.ok(actualUsd > 150 && actualUsd < 1_000, "limit and actual must not be 100x apart");
});

// Risk Governor — where the dollar daily-loss limit comes from.
//
// The shipped code derived it as `Math.max(10, Math.round(pct * 50))` — a
// hardcoded "$50 per 1%" proxy with no relation to the account it protects —
// after reading `risk_settings` with `.orderBy(desc(id)).limit(1)` and NO user
// predicate, so the most recently created user's row governed everyone.
//
// The limit is now the trader's configured percentage applied to their own
// account equity, and when there is no equity to apply it to the result is an
// explicit UNKNOWN with a limit of 0 — which callers must read as "not
// derived", never as "no limit". Mutate deriveDailyLossLimit back to the $50
// proxy and the first three cases go red.
//
// Run: node --import tsx --test src/lib/riskGovernor/__qa__/dailyLossLimitBasis.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveDailyLossLimit } from "../governor.js";

test("the limit is the configured percentage OF THE ACCOUNT, not $50 per 1%", () => {
  // 2% of a $10,000 paper account is $200. The old proxy said $100.
  const d = deriveDailyLossLimit(2, 10_000);
  assert.equal(d.basis, "PAPER_ACCOUNT_EQUITY");
  assert.equal(d.limit, 200);
  assert.notEqual(d.limit, Math.max(10, Math.round(2 * 50)));
});

test("the limit tracks the account balance", () => {
  assert.equal(deriveDailyLossLimit(2, 1_000).limit, 20);
  assert.equal(deriveDailyLossLimit(2, 50_000).limit, 1_000);
  // Same percentage, 50x the account, 50x the dollar budget. The old proxy
  // returned $100 for all three.
});

test("the limit tracks the trader's configured percentage", () => {
  assert.equal(deriveDailyLossLimit(1, 10_000).limit, 100);
  assert.equal(deriveDailyLossLimit(5, 10_000).limit, 500);
});

test("no equity means UNKNOWN — never an invented dollar figure", () => {
  for (const equity of [null, 0, -1]) {
    const d = deriveDailyLossLimit(2, equity);
    assert.equal(d.basis, "UNKNOWN", `equity=${equity}`);
    assert.equal(d.limit, 0, "0 here means NOT DERIVED, and the evaluator treats it as such");
  }
});

test("no configured percentage means UNKNOWN", () => {
  const d = deriveDailyLossLimit(null, 10_000);
  assert.equal(d.basis, "UNKNOWN");
  assert.equal(d.limit, 0);
});

test("the derived limit is rounded to whole cents", () => {
  const d = deriveDailyLossLimit(0.333, 1_000);
  assert.equal(d.limit, 3.33);
});

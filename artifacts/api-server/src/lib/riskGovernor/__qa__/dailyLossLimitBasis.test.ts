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
const { deriveDailyLossLimit } = await import("../governor.js");

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

// ── Who the UNKNOWN block can actually reach ───────────────────────────────
//
// The UNKNOWN fail-closed block is correct, but it is only a per-trader stop
// if the metrics it reads are per-trader. Shipped, two things made it
// instance-wide:
//
//   1. lib/paperExecution/paperExecutionService.ts called `gateForPaperTrade()`
//      with NO userId, so collectMetrics summed EVERY user's closed paper
//      orders into dailyPnl and returned basis "UNKNOWN" — meaning on any day
//      the platform's aggregate paper P&L was negative, every user's
//      decision-driven paper execution was rejected.
//   2. collectMetrics read risk_settings with a bare select, so a trader who
//      had never opened the Risk Settings page had no row, no percentage, and
//      therefore a permanent UNKNOWN block on their own account.
//
// These are source pins because the defect is the ABSENCE of an argument and
// the CHOICE of accessor — neither is observable from deriveDailyLossLimit.

test("the paper-execution gate is scoped to the trader whose trade it is", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const raw = readFileSync(
    join(import.meta.dirname, "..", "..", "paperExecution", "paperExecutionService.ts"), "utf-8");
  assert.ok(
    !/await\s+gateForPaperTrade\(\s*\)/.test(raw),
    "gateForPaperTrade() is being called with no userId again — that makes dailyPnl an "
    + "instance-wide sum and turns the UNKNOWN block into a platform-wide outage",
  );
  assert.match(raw, /gateForPaperTrade\(\s*userId\s*\)/);
});

test("a paper account is created OWNED, so equity can be found again", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const raw = readFileSync(
    join(import.meta.dirname, "..", "..", "paperExecution", "paperExecutionService.ts"), "utf-8");
  const insertAt = raw.indexOf("db.insert(paperAccountsTable).values({");
  assert.ok(insertAt > 0, "the paper-account insert moved — re-point this pin");
  const values = raw.slice(insertAt, insertAt + 400);
  assert.match(
    values, /userId,/,
    "paper accounts must be created with an owner; an unowned account has no equity the "
    + "governor can apply the trader's percentage to, which forces basis UNKNOWN",
  );
});

test("the governor materialises the trader's risk settings instead of reporting UNKNOWN", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const raw = readFileSync(join(import.meta.dirname, "..", "governor.ts"), "utf-8");
  assert.ok(
    raw.includes("getOrCreateUserRiskSettings"),
    "collectMetrics must use the canonical risk-settings accessor — a bare select leaves a "
    + "trader who never visited Risk Settings permanently inside the UNKNOWN hard block",
  );
  assert.ok(
    !/db\.select\(\)\.from\(riskSettingsTable\)/.test(raw),
    "the bare risk_settings select is back",
  );
});

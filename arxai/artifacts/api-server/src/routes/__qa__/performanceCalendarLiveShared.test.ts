// Truth: for a LIVE_SHARED session the paper calendar is withheld because
// live trades are not totalled by performanceCC. The withheld view must say
// that its numbers are unknown. It must not report a month of 0.00 P&L and 0
// trades, or invent a day rating of "F" and a profit factor of 0.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { withRouter } from "./_fakeRouteDb.js";

let accountMode: "LIVE_SHARED" | "PAPER" = "LIVE_SHARED";
const realScope = await import("../../lib/modeScope/getUserModeScope.js");
mock.module("../../lib/modeScope/getUserModeScope.js", { namedExports: {
  ...realScope,
  getUserModeScope: async () => ({ currentAccountMode: accountMode }),
} });
const router = (await import("../performanceCommandCenter.js")).default;

async function getJson(path: string): Promise<Record<string, any>> {
  let body: Record<string, any> = {};
  await withRouter(router, { id: 7, role: "user" }, async (base) => {
    const r = await fetch(`${base}${path}`);
    body = await r.json() as Record<string, any>;
    assert.equal(r.status, 200, JSON.stringify(body));
  });
  return body;
}

test("LIVE_SHARED /performance/day: no invented F rating, profit factor or win rate", async () => {
  accountMode = "LIVE_SHARED";
  const body = await getJson("/performance/day?date=2026-10-27");
  const stats = body.day.stats;
  assert.notEqual(stats.day_rating, "F");
  assert.equal(stats.day_rating, null);
  assert.equal(stats.profit_factor, null);
  assert.equal(stats.win_rate, null);
  assert.equal(stats.net_pnl, null);
  assert.equal(stats.total_trades, null);
  assert.equal(body.currentAccountMode, "LIVE_SHARED");
  assert.equal(body.liveAggregation, "NOT_AVAILABLE");
  assert.match(String(body.modeNote), /not zero/i);
  assert.doesNotMatch(String(body.modeNote), /no live trades recorded/i);
});

test("LIVE_SHARED /performance/calendar: month totals are unknown, not 0", async () => {
  accountMode = "LIVE_SHARED";
  const body = await getJson("/performance/calendar?month=2026-10");
  const cal = body.calendar;
  assert.equal(cal.month, "2026-10");
  assert.deepEqual(cal.days, []);
  assert.equal(cal.total_pnl, null);
  assert.equal(cal.total_trades, null);
  assert.equal(cal.winning_days, null);
  assert.equal(cal.losing_days, null);
  assert.equal(cal.no_trade_days, null);
  assert.equal(body.currentAccountMode, "LIVE_SHARED");
  assert.equal(body.liveAggregation, "NOT_AVAILABLE");
  assert.match(String(body.modeNote), /live/i);
  assert.doesNotMatch(String(body.modeNote), /no live trades recorded/i);
});

// Truth: a closed live trade whose P&L has not been recorded yet (pnl NULL —
// the EA fills it in after execution, or sizing is still pending) is counted
// by GET /api/me/performance-calendar as 0 / breakeven, so its day read as a
// measured 0.00 BREAK_EVEN_DAY. The day aggregate now also says how many of
// its trades have no recorded P&L (pnlNotRecorded), so the calendar can show
// the day as not fully measured. The existing figures are unchanged.
//
// Only the database, envelope and mode scope are stubbed; the real router runs.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/routes/__qa__/mePerformanceCalendarPnlNotRecorded.test.ts
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeDb, withRouter } from "./_fakeRouteDb.js";

const realDb = await import("@workspace/db");
let fake = createFakeDb({});
const dbProxy = new Proxy({}, { get: (_t, p) => (fake.db as Record<string | symbol, unknown>)[p] });
mock.module("@workspace/db", { namedExports: { ...realDb, db: dbProxy } });

const realEnv = await import("../../lib/adminTrading/safetyEnvelope.js");
mock.module("../../lib/adminTrading/safetyEnvelope.js", { namedExports: {
  ...realEnv,
  getEnvelope: async () => ({ ...realEnv.FAIL_CLOSED_ENVELOPE, tradingMode: "LIVE" }),
} });
const realScope = await import("../../lib/modeScope/getUserModeScope.js");
mock.module("../../lib/modeScope/getUserModeScope.js", { namedExports: {
  ...realScope,
  getUserModeScope: async () => ({ currentAccountMode: "LIVE_OWN" }),
} });
const router = (await import("../mePerformanceCalendar.js")).default;

const closedAt = new Date("2026-10-27T10:00:00.000Z");
function liveRow(id: number, pnl: number | null) {
  return {
    id, userId: 7, symbol: "EURUSD", side: "BUY", lotSize: 1, entryPrice: 1.08, closePrice: 1.09,
    pnl, status: "closed", closedAt,
  };
}

async function get(path: string): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> = {};
  await withRouter(router, { id: 7, role: "user" }, async (base) => {
    const r = await fetch(`${base}${path}`);
    body = await r.json() as Record<string, unknown>;
    assert.equal(r.status, 200, JSON.stringify(body));
  });
  return body;
}

test("a closed live trade with no recorded P&L is counted in pnlNotRecorded, not hidden in a 0.00 day", async () => {
  fake = createFakeDb({ shared_trade_attribution: [liveRow(1, null)] });
  const body = await get("/me/performance-calendar?from=2026-10-01&to=2026-10-31");
  const days = body["days"] as Array<Record<string, unknown>>;
  assert.equal(days.length, 1);
  assert.equal(days[0]!["tradesCount"], 1);
  assert.equal(days[0]!["pnlNotRecorded"], 1);
  // The existing figures are unchanged (null still adds 0 to the total).
  assert.equal(days[0]!["totalPnl"], 0);
});

test("a day with one recorded and one unrecorded P&L reports 1 not recorded", async () => {
  fake = createFakeDb({ shared_trade_attribution: [liveRow(1, 5), liveRow(2, null)] });
  const body = await get("/me/performance-calendar?from=2026-10-01&to=2026-10-31");
  const day = (body["days"] as Array<Record<string, unknown>>)[0]!;
  assert.equal(day["tradesCount"], 2);
  assert.equal(day["pnlNotRecorded"], 1);
  assert.equal(day["totalPnl"], 5);
});

test("fully recorded days report pnlNotRecorded 0", async () => {
  fake = createFakeDb({ shared_trade_attribution: [liveRow(1, 5), liveRow(2, -2)] });
  const body = await get("/me/performance-calendar?from=2026-10-01&to=2026-10-31");
  assert.equal((body["days"] as Array<Record<string, unknown>>)[0]!["pnlNotRecorded"], 0);
});

test("the day detail keeps the unrecorded trade's pnl as null and counts it", async () => {
  fake = createFakeDb({ shared_trade_attribution: [liveRow(1, null)] });
  const body = await get("/me/performance-calendar/2026-10-27");
  assert.equal(body["pnlNotRecorded"], 1);
  const trades = body["trades"] as Array<Record<string, unknown>>;
  assert.equal(trades[0]!["pnl"], null);
});

test("a day with no trades reports pnlNotRecorded 0", async () => {
  fake = createFakeDb({ shared_trade_attribution: [] });
  const body = await get("/me/performance-calendar/2026-10-27");
  assert.equal(body["tradesCount"], 0);
  assert.equal(body["pnlNotRecorded"], 0);
});

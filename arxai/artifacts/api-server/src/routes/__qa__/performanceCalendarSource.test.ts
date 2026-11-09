// Truth: GET /me/performance-calendar and /me/performance-summary switch their
// book on the safety envelope's tradingMode: LIVE reads closed live trades
// (shared_trade_attribution), anything else reads demo paper_trades, and a
// LIVE_SHARED mode scope returns an empty book. My Demo Trades labelled every
// one of those answers "demo", so a live-mode user saw an empty live calendar
// under "Close a demo trade" next to a Trades tab full of closed demo trades.
// Each response now says which book it read (`source`).
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeDb, withRouter } from "./_fakeRouteDb.js";

const closedAt = new Date("2026-10-27T10:00:00.000Z");
const realDb = await import("@workspace/db");
const fake = createFakeDb({
  paper_trades: [{ id: 1, userId: 7, symbol: "EURUSD", side: "buy", status: "closed", pnl: 5, lotSize: 1, entryPrice: 1.085, exitPrice: 1.09, strategyTag: null, riskAmount: null, closedAt }],
  shared_trade_attribution: [],
});
mock.module("@workspace/db", { namedExports: { ...realDb, db: fake.db } });

let tradingMode = "LIVE";
let accountMode = "DEMO";
const realEnv = await import("../../lib/adminTrading/safetyEnvelope.js");
mock.module("../../lib/adminTrading/safetyEnvelope.js", { namedExports: {
  ...realEnv, getEnvelope: async () => ({ tradingMode }),
} });
const realScope = await import("../../lib/modeScope/getUserModeScope.js");
mock.module("../../lib/modeScope/getUserModeScope.js", { namedExports: {
  ...realScope, getUserModeScope: async () => ({ currentAccountMode: accountMode }),
} });
const router = (await import("../mePerformanceCalendar.js")).default;

async function get(path: string): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> = {};
  await withRouter(router, { id: 7 }, async (base) => {
    const r = await fetch(`${base}${path}`);
    assert.equal(r.status, 200);
    body = await r.json() as Record<string, unknown>;
  });
  return body;
}

test("envelope LIVE, scope not LIVE_SHARED: the calendar and summary say they read live trades, not demo trades", async () => {
  tradingMode = "LIVE"; accountMode = "DEMO";
  const cal = await get("/me/performance-calendar");
  assert.equal(cal["source"], "live_trades");
  assert.deepEqual(cal["days"], []);
  const sum = await get("/me/performance-summary");
  assert.equal(sum["source"], "live_trades");
  const day = await get("/me/performance-calendar/2026-10-27");
  assert.equal(day["source"], "live_trades");
});

test("demo envelope: the calendar and summary say they read demo paper trades", async () => {
  tradingMode = "DEMO"; accountMode = "DEMO";
  const cal = await get("/me/performance-calendar");
  assert.equal(cal["source"], "paper_trades");
  assert.equal((cal["days"] as unknown[]).length, 1);
  const sum = await get("/me/performance-summary");
  assert.equal(sum["source"], "paper_trades");
  assert.equal(sum["totalTrades"], 1);
});

test("LIVE_SHARED scope: the empty book is labelled withheld, not an empty demo record", async () => {
  tradingMode = "LIVE"; accountMode = "LIVE_SHARED";
  const cal = await get("/me/performance-calendar");
  assert.equal(cal["source"], "withheld_live_shared");
  const sum = await get("/me/performance-summary");
  assert.equal(sum["source"], "withheld_live_shared");
  const day = await get("/me/performance-calendar/2026-10-27");
  assert.equal(day["source"], "withheld_live_shared");
});

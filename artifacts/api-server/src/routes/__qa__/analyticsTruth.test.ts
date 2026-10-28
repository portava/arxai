// Truth: the Analytics Command Center describes the paper book accurately.
//
// Offline: the REAL analytics router (and its exported helpers) run over an
// in-memory db fake. No database, no broker, no network.
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createFakeDb, withRouter, type FakeRows } from "./_fakeRouteDb.js";

const realDb = await import("@workspace/db");
let fake = createFakeDb({});
const dbProxy = new Proxy({}, { get: (_t, p) => (fake.db as Record<string | symbol, unknown>)[p] });
mock.module("@workspace/db", { namedExports: { ...realDb, db: dbProxy } });

const mod = await import("../analytics.js");
const router = mod.default;

function setRows(rows: FakeRows) { fake = createFakeDb(rows); }
beforeEach(() => setRows({}));

function order(over: Record<string, unknown>) {
  return {
    id: 1, userId: 7, paperAccountId: 1, symbol: "EURUSD", direction: "BUY", orderType: "MARKET",
    lotSize: 1, entryPrice: 1.085, stopLoss: 1.08, takeProfit: 1.095, status: "CLOSED_TP",
    openedAt: new Date("2026-10-20T08:00:00Z"), closedAt: new Date("2026-10-20T09:00:00Z"),
    exitPrice: 1.095, profitLoss: 1, strategyId: null, tradePlanId: null, decisionId: null,
    clientRequestKey: null, createdAt: new Date(), updatedAt: new Date(),
    ...over,
  };
}

async function getJson(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> = {};
  await withRouter(router, { id: 7 }, async (base) => {
    const r = await fetch(`${base}${path}`, init);
    body = await r.json() as Record<string, unknown>;
    assert.equal(r.status, 200, JSON.stringify(body));
  });
  return body;
}

// ── Session heatmap ─────────────────────────────────────────────────────────
// New York closes at 21:00 UTC. A trade opened at 22:30 UTC (Sydney / Tokyo
// open) was counted in NEWYORK because every hour from 13 to 23 mapped there.
test("session: 21:00–24:00 UTC is the Asia-Pacific session, not New York", () => {
  assert.equal(mod.sessionOf(new Date("2026-10-20T22:30:00Z")), "ASIA");
  assert.equal(mod.sessionOf(new Date("2026-10-20T21:00:00Z")), "ASIA");
  assert.equal(mod.sessionOf(new Date("2026-10-20T03:00:00Z")), "ASIA");
  assert.equal(mod.sessionOf(new Date("2026-10-20T07:00:00Z")), "LONDON");
  assert.equal(mod.sessionOf(new Date("2026-10-20T13:00:00Z")), "NEWYORK");
  assert.equal(mod.sessionOf(new Date("2026-10-20T20:59:00Z")), "NEWYORK");
});

test("session: GET /analytics/session buckets a 22:30Z trade in ASIA and states the hours", async () => {
  setRows({
    paper_orders: [
      order({ id: 1, openedAt: new Date("2026-10-20T22:30:00Z") }),
      order({ id: 2, openedAt: new Date("2026-10-20T14:00:00Z") }),
    ],
    post_trade_debriefs: [],
  });
  const body = await getJson("/analytics/session");
  const session = body["session"] as Record<string, { trades: number }>;
  assert.equal(session["ASIA"]!.trades, 1);
  assert.equal(session["NEWYORK"]!.trades, 1);
  assert.match(String(body["sessionBasis"]), /NEWYORK 13:00–21:00/);
  assert.match(String(body["sessionBasis"]), /ASIA 21:00–07:00/);
});

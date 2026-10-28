// Weekly review: POST /weekly-reviews/generate attributes a trade to the
// week it CLOSED in.
//
// The route used to select trades by createdAt, so a trade opened last
// Friday and closed this Tuesday was counted in last week's "Closed N
// trades" and missing from this week's.
//
// Offline: the REAL router runs on loopback; db.select / db.insert /
// db.transaction are replaced by fixtures that hand back every seeded row
// (no database is contacted), so the week attribution under test is the
// route's own.

import { test, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { db, tradesTable } from "@workspace/db";

type Rec = (prop: string, args: unknown[]) => void;
function chain(resolve: () => Promise<unknown>, rec?: Rec): unknown {
  const handler: ProxyHandler<() => void> = {
    get(_t, prop) {
      if (prop === "then") return (a: (v: unknown) => unknown, b: (e: unknown) => unknown) => resolve().then(a, b);
      if (prop === "catch") return (b: (e: unknown) => unknown) => resolve().catch(b);
      if (prop === "finally") return (f: () => void) => resolve().finally(f);
      return (...args: unknown[]) => { rec?.(String(prop), args); return chain(resolve, rec); };
    },
  };
  return new Proxy(() => undefined, handler);
}

const T = (iso: string) => new Date(iso);
const TRADES = [
  // Opened last Friday, closed this Tuesday.
  { id: 7, userId: 9, symbol: "EURUSD", strategy: "breakout", entryPrice: 1.1, stopLoss: 1.09, takeProfit: 1.12,
    pnl: 50, status: "CLOSED_WIN", createdAt: T("2026-10-23T15:00:00Z"), closedAt: T("2026-10-27T09:00:00Z") },
  // Opened and closed last week.
  { id: 8, userId: 9, symbol: "GBPUSD", strategy: "pullback", entryPrice: 1.3, stopLoss: 1.29, takeProfit: 1.32,
    pnl: -10, status: "CLOSED_LOSS", createdAt: T("2026-10-21T08:00:00Z"), closedAt: T("2026-10-21T12:00:00Z") },
];

let stored: Record<string, unknown> | null = null;
mock.method(db, "select", () => {
  let table: unknown = null;
  return chain(async () => (table === tradesTable ? TRADES : []), (prop, args) => { if (prop === "from") table = args[0]; });
});
mock.method(db, "insert", () => chain(async () => undefined));
mock.method(db, "transaction", async (fn: (tx: unknown) => Promise<unknown>) => {
  const tx = {
    insert: () => {
      let values: unknown = null;
      return chain(async () => {
        const list = (Array.isArray(values) ? values : [values]) as Array<Record<string, unknown>>;
        return list.map((v, i) => ({ ...v, id: i + 1, createdAt: new Date(), updatedAt: new Date() }));
      }, (prop, args) => {
        if (prop !== "values") return;
        values = args[0];
        if (!Array.isArray(values) && stored === null) stored = values as Record<string, unknown>;
      });
    },
    delete: () => chain(async () => []),
    select: () => chain(async () => []),
  };
  return fn(tx);
});

const { default: router } = await import("../weeklyReviews.js");

let server: Server;
let base: string;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { authUser: { id: number } }).authUser = { id: 9 };
    (req as unknown as { log: unknown }).log = { error: () => undefined };
    next();
  });
  app.use(router);
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function generate(weekStart: string): Promise<Record<string, unknown>> {
  stored = null;
  const r = await fetch(`${base}/weekly-reviews/generate`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ weekStart }),
  });
  assert.equal(r.status, 200, await r.clone().text());
  assert.ok(stored, "a review row was written");
  return stored!;
}

test("last week's review excludes a trade that closed this week", async () => {
  const last = await generate("2026-10-19T00:00:00.000Z");
  assert.equal(last["totalTrades"], 1);
  assert.equal(last["netProfitLoss"], -10);
  assert.equal(last["bestTradeId"], 8);
  assert.doesNotMatch(String(last["aiSummary"]), /Closed 2 trades/);
});

test("this week's review counts the trade opened last Friday and closed this Tuesday", async () => {
  const now = await generate("2026-10-26T00:00:00.000Z");
  assert.equal(now["totalTrades"], 1);
  assert.equal(now["netProfitLoss"], 50);
  assert.equal(now["bestTradeId"], 7);
  assert.match(String(now["aiSummary"]), /Closed 1 trade:/);
});

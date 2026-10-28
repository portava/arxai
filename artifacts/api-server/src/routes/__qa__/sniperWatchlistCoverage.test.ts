// Sniper Watchlist says which scanned trades were actually evaluated.
//
// scannedCount was keys.length, including a trade that resolveTrade() could
// not read (skipped by `continue`), and the flag checks coerce a missing score
// or P&L to 0 (`?? 0`), so an unscored trade counted as "not flagged". The
// page then said "Scanned 3 open demo trades. None of the scanned trades are
// flagged for attention right now." about trades nothing evaluated.
//
// The response must count the unreadable trades and, per signal, the trades
// whose score could not be computed, so the page can say so.
//
// Offline: the envelope, open-position reader, ledger, running tracker and
// alert engine are module-mocked; db writes go to an in-memory fake; scoring
// and the exit plan run for real (no candles are passed, as in production).

import { test, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

process.env.DATABASE_URL = "postgres://qa:qa@127.0.0.1:1/offline_never_connects";
const database = await import("@workspace/db");
mock.method(database.pool, "query", () => { throw new Error("Unexpected database access"); });
mock.method(database.pool, "connect", () => { throw new Error("Unexpected database access"); });
const actualLedger = await import("../../lib/positions/ledger.js");
const actualMfe = await import("../../lib/intelligence/mfeTracker.js");
const actualAlerts = await import("../../lib/intelligence/alertEngine.js");

// One chainable, thenable fake for every query shape computeAndPersist uses.
function chain(result: unknown[]): Record<string, unknown> {
  const c: Record<string, unknown> = {};
  for (const m of ["from", "where", "limit", "orderBy", "onConflictDoUpdate", "set"]) c[m] = () => c;
  c["returning"] = async () => result;
  c["then"] = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej);
  return c;
}
const fakeDb = {
  select: () => chain([]),
  insert: () => ({
    values: (v: Record<string, unknown>) => chain([{
      ...v, id: 1,
      createdAt: new Date(Date.now() - 60_000), updatedAt: new Date(),
    }]),
  }),
  transaction: async () => null,
};
mock.module("@workspace/db", { namedExports: { ...database, db: fakeDb } });

mock.module("../../lib/adminTrading/safetyEnvelope.js", {
  namedExports: { getEnvelope: async () => ({ accountRoutingMode: "USER_OWNED_MT5", accountType: "demo" }) },
});
mock.module("../../lib/positions/openPositions.js", {
  namedExports: {
    readOpenPositions: async (opts: { venue: string }) =>
      opts.venue === "DEMO" ? [{ id: 1 }, { id: 2 }, { id: 3 }] : [],
  },
});

// Ledger reads in key order: lp_1 has a price and P&L, lp_2 cannot be read,
// lp_3 has no current price and no P&L.
const ledgerQueue: Array<Array<Record<string, unknown>>> = [];
function demoRow(id: number, over: Record<string, unknown>): Record<string, unknown> {
  return {
    id, userId: 9, symbol: "EURUSD", direction: "BUY", lotSize: 0.1,
    entryPrice: 1.1, currentPrice: 1.1005, stopLoss: 1.09, takeProfit: 1.13,
    unrealizedProfitLoss: 5, openedAt: new Date(Date.now() - 5 * 60_000), createdAt: new Date(),
    ...over,
  };
}
mock.module("../../lib/positions/ledger.js", {
  namedExports: {
    ...actualLedger,
    demoPositionLedger: { read: async () => ledgerQueue.shift() ?? [] },
  },
});
mock.module("../../lib/intelligence/mfeTracker.js", {
  namedExports: { ...actualMfe, getRunning: async () => ({ mfe: null, mae: null, peakPnl: null }) },
});
mock.module("../../lib/intelligence/alertEngine.js", {
  namedExports: { ...actualAlerts, evaluateAlerts: () => [] },
});
mock.module("../../lib/notificationService.js", {
  namedExports: { createNotification: async () => undefined },
});

const { default: router } = await import("../meTradeIntelligence.js");

let server: Server;
let base: string;
before(async () => {
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { authUser: { id: number } }).authUser = { id: 9 };
    (req as unknown as { log: unknown }).log = { error: (o: unknown) => console.error(o) };
    next();
  });
  app.use(router);
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

test("an unreadable trade and unscored signals are counted, not folded into 'not flagged'", async () => {
  ledgerQueue.length = 0;
  ledgerQueue.push(
    [demoRow(1, {})],
    [],
    [demoRow(3, { currentPrice: null, unrealizedProfitLoss: null })],
  );
  const r = await fetch(`${base}/me/sniper-watchlist`);
  assert.equal(r.status, 200);
  const body = (await r.json()) as Record<string, unknown>;
  assert.equal(body["scannedCount"], 3);
  assert.deepEqual(body["items"], []);
  assert.equal(body["unresolvedCount"], 1, "lp_2 could not be read");
  assert.equal(body["evaluatedCount"], 2);
  const gaps = body["signalGaps"] as Record<string, number>;
  assert.equal(gaps["closeUrgency"], 1, "lp_3 has no P&L, so close urgency was not scored");
  assert.equal(gaps["profitGiveback"], 1, "lp_3 has no P&L, so giveback was not checked");
  assert.equal(gaps["stopTargetProximity"], 1, "lp_3 has no current price, so SL/TP proximity was not checked");
  // No candles are passed to the scorer, so candle-based risk is never scored.
  assert.equal(gaps["reversalRisk"], 2);
  assert.equal(gaps["fakeoutRisk"], 2);
  assert.equal(gaps["volatilityRisk"], 2);
});

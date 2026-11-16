// Regression: POST /trade-management/:id/partial-close ("Close 50%" on the
// Live Trades card) removed half the position with no exit price and no
// result, even when the market-data feed had no quote for the symbol — the
// same condition that makes close and trail refuse with 409
// NO_CURRENT_QUOTE (round-1 fix 12c3559b guarded only those two).
//
// Now: no quote = 409 NO_CURRENT_QUOTE and the lot is not touched. With a
// quote, the reply names the price the part left at, the closed lot and its
// result, and says plainly that this result is not added to the trade's
// recorded P&L (the legacy trade row keeps one P&L, for the final close).
//
// The route and evaluateTrade run for real; the trade read, the quote, the
// contract size and the Position Guardian write are stubbed. No database,
// no network.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/routes/__qa__/tradeManagementPartialCloseTruth.test.ts

import { after, before, test, mock } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import type { Trade } from "@workspace/db";

const TRADE: Trade = {
  id: 7, userId: 7, symbol: "EURUSD", direction: "BUY", lot: 1,
  entryPrice: 1.1, stopLoss: 1.09, takeProfit: 1.12, strategy: "qa", confidence: 70,
  status: "OPEN", mode: "DEMO", pnl: null, pnlStatus: null, dataQualityFlag: null,
  reportedEaVersion: null, closedAt: null, createdAt: new Date(Date.now() - 30 * 60_000),
};

const realDb = await import("@workspace/db");
const fakeDb = {
  select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ ...TRADE }] }) }) }),
};
mock.module("@workspace/db", { namedExports: { ...realDb, db: fakeDb } });

type Quote = { symbol: string; timestamp: string; last?: number };
let nextQuote: Quote = { symbol: "EURUSD", timestamp: new Date().toISOString() };
const realData = await import("../../lib/data/dataManager.js");
mock.module("../../lib/data/dataManager.js", {
  namedExports: { ...realData, getLatestQuote: async (symbol: string) => ({ ...nextQuote, symbol }) },
});

const realContract = await import("../../lib/mt5/contractSize.js");
mock.module("../../lib/mt5/contractSize.js", {
  namedExports: {
    ...realContract,
    resolveContractSize: async (_userId: number, symbol: string) =>
      realContract.decideContractSize({ symbol, brokerContractSize: null, brokerProfitCurrency: null }),
  },
});

const guardianOps: Array<{ kind: string; newLot?: number }> = [];
mock.module("../../lib/positionGuardian/manage.js", {
  namedExports: {
    guardianPaperManage: async ({ trade, op }: { trade: Trade; op: { kind: string; newLot?: number } }) => {
      guardianOps.push(op);
      return { ok: true, trade: { ...trade, lot: op.newLot ?? trade.lot } };
    },
  },
});
mock.module("../../lib/alerts/alertManager.js", { namedExports: { createAlert: async () => undefined } });
mock.module("../../lib/brokerHub/mt5StateReader.js", { namedExports: { readScopedMt5State: async () => null } });

const { default: router } = await import("../tradeManagement.js");

let server: Server;
let base = "";
before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as unknown as { authUser: unknown }).authUser = { id: 7, role: "USER" }; next(); });
  app.use(router);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server?.close(); });

async function post(path: string, body?: unknown) {
  const r = await fetch(`${base}/trade-management/7/${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}),
  });
  return { status: r.status, body: await r.json() as Record<string, unknown> };
}

test("no quote: partial close refuses like close, and the lot is not touched", async () => {
  nextQuote = { symbol: "EURUSD", timestamp: new Date().toISOString() }; // router had no quote
  guardianOps.length = 0;
  const close = await post("close");
  assert.equal(close.status, 409);
  assert.equal(close.body["error"], "NO_CURRENT_QUOTE");
  const partial = await post("partial-close", { closePct: 50 });
  assert.equal(partial.status, 409, "the closed half would leave at an unknown price with no result");
  assert.equal(partial.body["error"], "NO_CURRENT_QUOTE");
  assert.match(String(partial.body["message"]), /no current quote for EURUSD/i);
  assert.equal(guardianOps.length, 0, "no lot change is written");
});

test("with a quote: the reply names the exit price and the closed part's result, and says it is not recorded", async () => {
  nextQuote = { symbol: "EURUSD", timestamp: new Date().toISOString(), last: 1.101 }; // +10 pips
  guardianOps.length = 0;
  const r = await post("partial-close", { closePct: 50 });
  assert.equal(r.status, 200);
  assert.deepEqual(guardianOps, [{ kind: "PARTIAL_CLOSE", newLot: 0.5 }]);
  const msg = String(r.body["message"]);
  assert.match(msg, /lot reduced from 1 to 0\.5/);
  assert.match(msg, /at 1\.10100/, "the price the closed part left at");
  assert.match(msg, /\+\$50\.00/, "the closed half's result: 0.5 lot x +10 pips on a 100,000 contract");
  assert.match(msg, /not added to this trade's recorded P&L/);
});

// Regression: /me/live/slot-summary set a position's grossProfit / netProfit to
// `floatingPl ?? 0`, so a row whose floating P/L the bridge never reported was
// shown as "Current P/L $0.00" on the Live Open Trades panel. An unknown P/L is
// not zero: the row must carry null and the account total must say it is
// incomplete.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
process.env.DATABASE_URL = "postgres://qa:qa@127.0.0.1:1/offline_never_connects";
const database = await import("@workspace/db");
mock.method(database.pool, "query", () => { throw new Error("Unexpected database access"); });
mock.method(database.pool, "connect", () => { throw new Error("Unexpected database access"); });

const now = Date.now();
const twoMinAgo = new Date(now - 120_000);
type Row = Record<string, unknown>;
let openRows: Row[] = [];

const fakeDb = {
  select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
};
mock.module("@workspace/db", { namedExports: { ...database, db: fakeDb } });

const openPositions = await import("../../lib/positions/openPositions.js");
mock.module("../../lib/positions/openPositions.js", {
  namedExports: { ...openPositions, readOpenPositions: async () => openRows.map((row) => ({ row })) },
});
const ledger = await import("../../lib/positions/ledger.js");
mock.module("../../lib/positions/ledger.js", {
  namedExports: { ...ledger, livePositionLedger: { ...ledger.livePositionLedger, select: async () => [{ realised: 0 }] } },
});
const connections = await import("../../lib/brokerHub/connections.js");
mock.module("../../lib/brokerHub/connections.js", {
  namedExports: {
    ...connections,
    getUserLiveBridge: async () => ({ leverage: 100, lastHeartbeat: new Date(now - 1_000), lastPositionsSnapshotAt: twoMinAgo }),
  },
});
const balance = await import("../../lib/live/investorLiveBalance.js");
mock.module("../../lib/live/investorLiveBalance.js", {
  namedExports: { ...balance, buildInvestorLiveBalanceSnapshot: async () => ({}), toInvestorLiveBalanceWire: () => null },
});

const { default: router } = await import("../meLiveAccount.js");

async function invoke(): Promise<{ status: number; body: any }> {
  const layer = (router as any).stack.find((l: any) => l.route?.path === "/me/live/slot-summary");
  assert.ok(layer, "missing route");
  let status = 200;
  let body: any;
  const response = {
    status(n: number) { status = n; return this; },
    json(data: unknown) { body = data; return this; },
  };
  const request = { authUser: { id: 7, role: "TRADER" }, query: {}, params: {} };
  const handlers = layer.route.stack;
  await handlers[handlers.length - 1].handle(request as unknown as Request, response as unknown as Response, () => {});
  return { status, body };
}

function row(patch: Row): Row {
  return {
    brokerTicket: "1001", symbol: "EURUSD", side: "BUY", volume: "0.10",
    entryPrice: "1.10000", currentPrice: "1.10100", stopLoss: null, takeProfit: null,
    floatingPl: null, openedAt: twoMinAgo, lastSyncedAt: twoMinAgo, ...patch,
  };
}

test("a position with no reported floating P/L carries null, not 0", async () => {
  openRows = [row({ floatingPl: null })];
  const { status, body } = await invoke();
  assert.equal(status, 200);
  assert.equal(body.isLive, true, "heartbeat is fresh in this scenario");
  assert.equal(body.positionSyncIncomplete, true, "snapshot is 2 minutes old");
  assert.equal(body.positions.length, 1);
  const p = body.positions[0];
  assert.equal(p.netProfit, null);
  assert.equal(p.grossProfit, null);
  assert.equal(p.profitPercentOfSlot, null);
  assert.equal(body.openPnLIncomplete, true);
});

test("a reported floating P/L is passed through and the total is complete", async () => {
  openRows = [row({ floatingPl: "12.5" })];
  const { body } = await invoke();
  assert.equal(body.positions[0].netProfit, 12.5);
  assert.equal(body.openPnL, 12.5);
  assert.equal(body.openPnLIncomplete, false);
});

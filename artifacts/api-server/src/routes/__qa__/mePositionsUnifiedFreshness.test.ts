// Regression: GET /me/positions/all dropped observedAt / lastSyncedAt from
// every row and only filtered against a RELATIVE floor (newest row − 90s), so
// when the whole bridge went offline every 10-minute-old row passed and the
// live-chart side card had nothing to show the age from. Each row now carries
// the time the bridge last reported it and an absolute freshness verdict.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
process.env.DATABASE_URL = "postgres://qa:qa@127.0.0.1:1/offline_never_connects";
const database = await import("@workspace/db");
mock.method(database.pool, "query", () => { throw new Error("Unexpected database access"); });
mock.method(database.pool, "connect", () => { throw new Error("Unexpected database access"); });

type Row = Record<string, unknown>;
let liveRows: Row[] = [];

const modeScope = await import("../../lib/modeScope/getUserModeScope.js");
mock.module("../../lib/modeScope/getUserModeScope.js", {
  namedExports: {
    ...modeScope,
    getUserModeScope: async (userId: number) => ({
      userId, currentAccountMode: "LIVE_SHARED", liveExecutionArmed: false,
      sharedMasterAttached: true, isAdmin: false, primaryDataDomain: "live",
    }),
  },
});
const openPositions = await import("../../lib/positions/openPositions.js");
mock.module("../../lib/positions/openPositions.js", {
  namedExports: { ...openPositions, readOpenPositions: async () => liveRows },
});
const stateReader = await import("../../lib/brokerHub/mt5StateReader.js");
mock.module("../../lib/brokerHub/mt5StateReader.js", {
  namedExports: { ...stateReader, readLatestUserMt5State: async () => null },
});

const { default: router } = await import("../mePositionsUnified.js");

async function invoke(): Promise<any> {
  const layer = (router as any).stack.find((l: any) => l.route?.path === "/me/positions/all");
  assert.ok(layer, "missing route");
  let body: any;
  const response = { status() { return this; }, json(data: unknown) { body = data; return this; } };
  const request = { authUser: { id: 7, role: "TRADER" }, query: {}, params: {}, log: { info: () => {}, error: () => {} } };
  const handlers = layer.route.stack;
  await handlers[handlers.length - 1].handle(request as unknown as Request, response as unknown as Response, () => {});
  return body;
}

function live(ticket: string, observedAt: Date): Row {
  return {
    venue: "LIVE", ticket, symbol: "XAUUSD", side: "BUY", lots: 0.1, entryPrice: 2400,
    currentPrice: 2405, stopLoss: 2390, takeProfit: null, floatingPnl: 50,
    openedAt: new Date(observedAt.getTime() - 3_600_000), recordedAt: observedAt, observedAt,
    sourceCommandId: null, bridgeConnectionId: 1, status: "OPEN", row: { closedAt: null },
  };
}

test("rows from a bridge silent for 10 minutes carry their observedAt and read STALE", async () => {
  const tenMinAgo = new Date(Date.now() - 10 * 60_000);
  liveRows = [live("1", tenMinAgo), live("2", tenMinAgo)];
  const body = await invoke();
  assert.equal(body.live.length, 2);
  for (const r of body.live) {
    assert.equal(r.observedAt, tenMinAgo.toISOString());
    assert.equal(r.freshness, "STALE");
  }
});

test("a just-reported row reads FRESH; a row with no sync time reads MISSING", async () => {
  liveRows = [live("1", new Date()), { ...live("2", new Date()), observedAt: null }];
  const body = await invoke();
  const byTicket = new Map(body.live.map((r: any) => [r.brokerTicket, r]));
  assert.equal((byTicket.get("1") as any).freshness, "FRESH");
  // A null-observedAt row sorts below the floor and is dropped by the existing
  // ghost filter; if present it must say MISSING.
  const second = byTicket.get("2") as any;
  if (second) assert.equal(second.freshness, "MISSING");
});

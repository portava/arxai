// Shared harness for GET /api/me/live/slot-summary route tests: stubs only the
// database handle, the live-bridge lookup and the canonical balance builder;
// the real router, read model and freshness classifier run. No network.

import { mock } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

export const USER_ID = 88;

export const state: {
  positions: Array<Record<string, unknown>>;
  bridge: Record<string, unknown> | null;
} = { positions: [], bridge: null };

export async function installSlotSummaryMocks(): Promise<void> {
  const database = await import("@workspace/db");
  const rowsFor = (table: unknown, projected: boolean): unknown[] => {
    if (table === database.userSlotAllocationTable) {
      return [{
        userId: USER_ID, allocatedFunds: 1000, accountCurrency: "USD", isActive: true, allocationStatus: "active",
        tradingFrozen: false, aiAutoTradingEnabled: false, aiAllocatedFunds: 0, aiStrategyMode: null,
        aiMaxLot: null, aiMaxDailyLossUsd: null, aiTradingFrozen: false,
      }];
    }
    if (table === database.arxLivePositionsTable) return projected ? [{ realised: 0 }] : state.positions;
    return [];
  };
  const chain = (rows: () => unknown[]): Record<string, unknown> => {
    const q: Record<string, unknown> = {};
    const self = () => q;
    q.$dynamic = self; q.where = self; q.orderBy = self; q.limit = self; q.groupBy = self;
    q.then = (resolve: (v: unknown[]) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve().then(rows).then(resolve, reject);
    return q;
  };
  const fakeDb = {
    select: (fields?: unknown) => ({ from: (t: unknown) => chain(() => rowsFor(t, fields !== undefined)) }),
    selectDistinct: (fields?: unknown) => ({ from: (t: unknown) => chain(() => rowsFor(t, fields !== undefined)) }),
  };
  mock.module("@workspace/db", { namedExports: { ...database, db: fakeDb } });

  const connections = await import("../../lib/brokerHub/connections.js");
  mock.module("../../lib/brokerHub/connections.js", {
    namedExports: { ...connections, getUserLiveBridge: async () => state.bridge },
  });
  const balance = await import("../../lib/live/investorLiveBalance.js");
  mock.module("../../lib/live/investorLiveBalance.js", {
    namedExports: {
      ...balance,
      buildInvestorLiveBalanceSnapshot: async () => null,
      toInvestorLiveBalanceWire: () => null,
    },
  });
}

export function positionRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 1, userId: USER_ID, brokerTicket: "5001", symbol: "EURUSD", side: "BUY", volume: 0.1, entryPrice: 1.1,
    stopLoss: null, takeProfit: null, currentPrice: 1.1005, floatingPl: 5, openedAt: new Date(), createdAt: new Date(),
    lastSyncedAt: new Date(), sourceCommandId: null, bridgeConnectionId: 3, reconcileState: null, closedAt: null,
    ...over,
  };
}

export async function getSlotSummary(): Promise<Record<string, unknown>> {
  const { default: express } = await import("express");
  const { default: router } = await import("../meLiveAccount.js");
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { authUser: unknown }).authUser = { id: USER_ID, role: "USER" };
    (req as unknown as { log: unknown }).log = { info() {}, warn() {}, error() {} };
    next();
  });
  app.use(router);
  const server: Server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  try {
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/me/live/slot-summary`);
    assert.equal(res.status, 200);
    return (await res.json()) as Record<string, unknown>;
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

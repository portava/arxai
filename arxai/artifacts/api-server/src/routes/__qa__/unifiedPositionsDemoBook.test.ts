// GET /api/me/positions/all — the DEMO half must list the user's real,
// broker-confirmed open DEMO positions (live_positions, status OPEN), with the
// broker's own entry / SL / TP / price / floating P/L.
//
// The defect this locks: the route read a per-user mt5_state snapshot that no
// EA writer ever stamps with a user id, and mapped field names
// (openPrice / stopLoss / ...) the EA payload does not carry (entry / sl / tp).
// A DEMO trader with open positions saw an empty picker ("0").
//
// Only the database handle and the mode resolver are stubbed; the real router,
// the real open-position read model and the real ledger run. No network.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/routes/__qa__/unifiedPositionsDemoBook.test.ts

import { mock, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const database = await import("@workspace/db");
const dialect = new PgDialect();
const USER_ID = 4242;
const NOW = new Date("2026-10-28T12:00:00.000Z");

const livePositionsWheres: SQL[] = [];

/** Chainable query stub: every builder call returns itself; awaiting yields rows for the table. */
function query(table: unknown): Record<string, unknown> {
  let where: SQL | undefined;
  const rowsFor = (): unknown[] => {
    if (table === database.livePositionsTable) {
      if (where) livePositionsWheres.push(where);
      return [
        {
          id: 1, userId: USER_ID, brokerPositionId: "1001", symbol: "EURUSD", direction: "BUY", lotSize: 0.1,
          entryPrice: 1.1, stopLoss: 1.09, takeProfit: 1.12, currentPrice: 1.1032, unrealizedProfitLoss: 3.2,
          status: "OPEN", openedAt: new Date("2026-10-28T11:00:00.000Z"), createdAt: new Date("2026-10-28T11:00:01.000Z"),
          lastSyncedAt: NOW, closedAt: null,
        },
        {
          // status OPEN but the broker never confirmed a ticket: not a position to list.
          id: 2, userId: USER_ID, brokerPositionId: null, symbol: "GBPUSD", direction: "SELL", lotSize: 0.2,
          entryPrice: 1.3, stopLoss: null, takeProfit: null, currentPrice: null, unrealizedProfitLoss: null,
          status: "OPEN", openedAt: null, createdAt: NOW, lastSyncedAt: null, closedAt: null,
        },
      ];
    }
    if (table === database.mt5StateTable) {
      // What the EA actually pushes (Mt5SyncPositionsBody field names).
      return [{ id: 7, userId: USER_ID, lastSyncAt: NOW, positions: [
        { ticket: 1001, symbol: "EURUSD", side: "BUY", lot: 0.1, entry: 1.1, sl: 1.09, tp: 1.12, profit: 3.2 },
      ] }];
    }
    if (table === database.mt5DemoCommandsTable) {
      return [{ commandId: "dmcmd_1", brokerTicket: "1001", sourcePage: "SCANNER" }];
    }
    return [];
  };
  const q: Record<string, unknown> = {};
  const self = () => q;
  q.$dynamic = self;
  q.where = (w: SQL) => { where = w; return q; };
  q.orderBy = self;
  q.groupBy = self;
  q.limit = self;
  q.then = (resolve: (v: unknown[]) => unknown, reject: (e: unknown) => unknown) => {
    try { return Promise.resolve(rowsFor()).then(resolve, reject); } catch (e) { return reject(e); }
  };
  return q;
}

const fakeDb = {
  select: () => ({ from: (table: unknown) => query(table) }),
  selectDistinct: () => ({ from: (table: unknown) => query(table) }),
};
mock.module("@workspace/db", { namedExports: { ...database, db: fakeDb } });

const realScope = await import("../../lib/modeScope/getUserModeScope.js");
mock.module("../../lib/modeScope/getUserModeScope.js", {
  namedExports: {
    ...realScope,
    getUserModeScope: async (userId: number) => ({
      userId, currentAccountMode: "DEMO", liveExecutionArmed: false, sharedMasterAttached: false,
      isAdmin: false, primaryDataDomain: "demo",
    }),
  },
});

const { default: express } = await import("express");
const { default: router } = await import("../mePositionsUnified.js");

async function getAll(): Promise<Record<string, unknown>> {
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { authUser: unknown }).authUser = { id: USER_ID, role: "USER" };
    (req as unknown as { log: unknown }).log = { info() {}, warn() {}, error() {} };
    next();
  });
  app.use(router);
  const server: Server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try {
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/me/positions/all`);
    assert.equal(res.status, 200);
    return (await res.json()) as Record<string, unknown>;
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test("DEMO user: the unified feed lists the broker-confirmed open DEMO book with the broker's levels", async () => {
  const body = await getAll();
  const demo = body["demo"] as Array<Record<string, unknown>>;
  assert.equal(body["demoCount"], 1, "one confirmed open DEMO position (the ticket-less row is not listed)");
  assert.equal(demo.length, 1);
  const p = demo[0]!;
  assert.equal(p["brokerTicket"], "1001");
  assert.equal(p["symbol"], "EURUSD");
  assert.equal(p["side"], "BUY");
  assert.equal(p["lotSize"], 0.1);
  assert.equal(p["entryPrice"], 1.1);
  assert.equal(p["stopLoss"], 1.09);
  assert.equal(p["takeProfit"], 1.12);
  assert.equal(p["currentPrice"], 1.1032);
  assert.equal(p["floatingPnl"], 3.2);
  assert.equal(p["openedAt"], "2026-10-28T11:00:00.000Z");
  assert.equal(p["observedAt"], NOW.toISOString());
  assert.equal(p["sourceCommandId"], "dmcmd_1");
  assert.deepEqual(body["live"], [], "a DEMO user sees no LIVE rows");
});

test("the DEMO read is scoped to this user and to status OPEN", async () => {
  livePositionsWheres.length = 0;
  await getAll();
  assert.ok(livePositionsWheres.length >= 1, "live_positions (the DEMO ledger) was consulted");
  const q = dialect.sqlToQuery(livePositionsWheres[0]!);
  assert.match(q.sql, /"user_id" = \$\d/);
  assert.match(q.sql, /"status" = \$\d/);
  assert.ok(q.params.includes(USER_ID));
  assert.ok(q.params.includes("OPEN"));
});

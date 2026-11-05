// GET /api/mt5/status — the open-position list is a literal [] (this status
// reads the connection row only, never the broker's positions). It must say
// so, so the MT5 Bridge page cannot turn it into a confident "Open Trades 0"
// or a "Position sync completed · Success" row. The account snapshot carries
// its own sync time so the page can date it honestly.
//
// Only the database handle and the connection lookup are stubbed; the real
// router runs. No network, no broker.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/routes/__qa__/mt5StatusPositionsUnmeasured.test.ts

import { mock, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const database = await import("@workspace/db");
function chain(rows: unknown[]): Record<string, unknown> {
  const q: Record<string, unknown> = {};
  const self = () => q;
  q.from = self; q.where = self; q.groupBy = self; q.orderBy = self; q.limit = self;
  q.then = (resolve: (v: unknown[]) => unknown) => Promise.resolve(rows).then(resolve);
  return q;
}
mock.module("@workspace/db", { namedExports: { ...database, db: { select: () => chain([]) } } });

const SYNCED = new Date(Date.now() - 4_000);
let connection: Record<string, unknown> | null = null;
const realConnections = await import("../../lib/brokerHub/connections.js");
mock.module("../../lib/brokerHub/connections.js", {
  namedExports: { ...realConnections, getUserActiveConnection: async () => connection },
});

const { default: express } = await import("express");
const { default: router } = await import("../mt5.js");

async function status(): Promise<Record<string, unknown>> {
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { authUser: unknown }).authUser = { id: 31, role: "USER" };
    (req as unknown as { log: unknown }).log = { info() {}, warn() {}, error() {} };
    next();
  });
  app.use(router);
  const server: Server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  try {
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/mt5/status`);
    assert.equal(res.status, 200);
    return (await res.json()) as Record<string, unknown>;
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test("a connected bridge reports that open positions were not read, not a measured empty book", async () => {
  connection = {
    id: 5, userId: 31, mode: "DEMO", lastHeartbeat: new Date(Date.now() - 2_000), accountSyncedAt: SYNCED,
    accountNumber: "1234567", brokerName: "QA Broker", serverName: "QA-Demo", accountBalance: 10_000,
    accountEquity: 10_050, margin: 40, freeMargin: 9_960, accountCurrency: "USD", hasBridgeToken: true,
  };
  const s = await status();
  assert.equal(s["connected"], true);
  assert.equal(s["openPositionsMeasured"], false);
  assert.match(String(s["openPositionsNote"]), /not read/);
  const snap = s["accountSnapshot"] as Record<string, unknown>;
  assert.equal(snap["syncedAt"], SYNCED.toISOString());
});

test("no connection: positions are still reported as not read", async () => {
  connection = null;
  const s = await status();
  assert.equal(s["connected"], false);
  assert.equal(s["openPositionsMeasured"], false);
});

// readLatestUserMt5State callers: the EA bridge writes only the install-wide
// mt5_state row and never stamps a user on it, so for a DEMO user the per-user
// read is normally null. These callers used to turn that null into a measured
// "no open positions" / "MT5 open: 0, in sync" / "no baskets" and, in the
// scalp journal, finalized every open journal entry as closed. Each must now
// say the positions were not read.
//
// Stubbed: the database handle, the per-user mt5_state read, the mode scope,
// the scalp inputs and the scalp journal. The real route and services run.
// No network, no broker.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/lib/brokerHub/__qa__/mt5StateUnattributedReaders.test.ts

import { mock, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const database = await import("@workspace/db");
function chain(rows: unknown[]): Record<string, unknown> {
  const q: Record<string, unknown> = {};
  const self = () => q;
  q.from = self; q.where = self; q.groupBy = self; q.orderBy = self; q.limit = self; q.innerJoin = self; q.leftJoin = self;
  q.then = (resolve: (v: unknown[]) => unknown) => Promise.resolve(rows).then(resolve);
  return q;
}
mock.module("@workspace/db", { namedExports: { ...database, db: { select: () => chain([]) } } });

let userRow: Record<string, unknown> | null = null;
const realReader = await import("../mt5StateReader.js");
mock.module("../mt5StateReader.js", {
  namedExports: { ...realReader, readLatestUserMt5State: async () => userRow },
});

const realScope = await import("../../modeScope/getUserModeScope.js");
mock.module("../../modeScope/getUserModeScope.js", {
  namedExports: { ...realScope, getUserModeScope: async () => ({ currentAccountMode: "DEMO" }) },
});

const realLedger = await import("../../positions/ledger.js");
mock.module("../../positions/ledger.js", {
  namedExports: { ...realLedger, livePositionLedger: { read: async () => [] } },
});

const journalCalls: unknown[] = [];
const realJournal = await import("../../scalp/scalpJournalService.js");
mock.module("../../scalp/scalpJournalService.js", {
  namedExports: { ...realJournal, recordScalpBasketsObservation: async (...args: unknown[]) => { journalCalls.push(args); } },
});

const realInputs = await import("../../scalp/scalpServiceInputs.js");
mock.module("../../scalp/scalpServiceInputs.js", {
  namedExports: {
    ...realInputs,
    candleWindowFor: async () => null,
    currentPriceFor: async () => null,
    loadExecutionInput: async () => null,
    loadSpecInput: async () => ({
      hasBrokerTruth: false, tradeMode: null, tradeAllowed: null, visible: null, marketOpen: null,
      digits: 5, point: 0.00001, minLot: 0.01, maxLot: 100, lotStep: 0.01, contractSize: 100000,
      tickSize: null, tickValue: null, stopsLevelPoints: 0, spreadPoints: 10, category: "forex",
      displayName: "EURUSD", profitCurrency: "USD",
    }),
  },
});

const { buildTradeHealthForUser } = await import("../../tradeHealth/tradeHealthService.js");
const { getScalpBaskets, getAddOnCheck } = await import("../../scalp/scalpManageService.js");
const { default: express } = await import("express");
const { default: demoRouter } = await import("../../../routes/meDemoPositions.js");

async function demoSnapshot(): Promise<Record<string, unknown>> {
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { authUser: unknown }).authUser = { id: 41, role: "USER" };
    next();
  });
  app.use(demoRouter);
  const server: Server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  try {
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/me/demo-positions-snapshot`);
    assert.equal(res.status, 200);
    return (await res.json()) as Record<string, unknown>;
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const SYNCED_ROW = {
  id: 9, userId: 41, lastSyncAt: new Date(Date.now() - 3_000),
  positions: [{ ticket: 77, symbol: "EURUSD", side: "BUY", lot: 0.1, openPrice: 1.1, currentPrice: 1.101, profit: 10 }],
};

test("demo positions snapshot: no row of the user's own is 'not read', not 'MT5 open 0, in sync'", async () => {
  userRow = null;
  const s = await demoSnapshot();
  assert.equal(s["positionsMeasured"], false);
  assert.match(String(s["positionsNote"]), /not read here\. This is not a count of zero/);
  const recon = s["reconciliation"] as Record<string, unknown>;
  assert.equal(recon["mt5OpenPositionCount"], null);
  assert.equal(recon["inSync"], null);
});

test("demo positions snapshot: a row of the user's own is measured", async () => {
  userRow = SYNCED_ROW;
  const s = await demoSnapshot();
  assert.equal(s["positionsMeasured"], true);
  assert.equal(s["positionsNote"], null);
  const recon = s["reconciliation"] as Record<string, unknown>;
  assert.equal(recon["mt5OpenPositionCount"], 1);
});

test("trade health: an unread demo book does not say 'no open positions'", async () => {
  userRow = null;
  const r = await buildTradeHealthForUser({ userId: 41, isAdmin: false, chartSymbol: null, nowMs: Date.now() });
  assert.equal(r.positionsMeasured, false);
  assert.ok(!/no open positions/i.test(r.report.summary), `summary claims a measured empty book: ${r.report.summary}`);
  assert.match(r.report.summary, /could not be checked/);
});

test("trade health: a read demo book is measured", async () => {
  userRow = { ...SYNCED_ROW, positions: [] };
  const r = await buildTradeHealthForUser({ userId: 41, isAdmin: false, chartSymbol: null, nowMs: Date.now() });
  assert.equal(r.positionsMeasured, true);
  assert.equal(r.positionsNote, null);
});

test("scalp baskets: an unread demo book is flagged and never finalizes the journal", async () => {
  userRow = null;
  journalCalls.length = 0;
  const r = await getScalpBaskets(41, {});
  assert.deepEqual(r.baskets, []);
  assert.equal(r.positionsMeasured, false);
  assert.match(String(r.positionsNote), /not read here/);
  assert.equal(journalCalls.length, 0, "journal finalize ran on an unread book");
});

test("scalp baskets: a read demo book still journals", async () => {
  userRow = { ...SYNCED_ROW, positions: [] };
  journalCalls.length = 0;
  const r = await getScalpBaskets(41, {});
  assert.equal(r.positionsMeasured, true);
  assert.equal(journalCalls.length, 1);
});

test("scalp add-on check: hasOpenBasket false on an unread book is flagged as not measured", async () => {
  userRow = null;
  const r = await getAddOnCheck(41, { symbol: "EURUSD", direction: "BUY" }, {});
  assert.equal(r.hasOpenBasket, false);
  assert.equal(r.positionsMeasured, false);
  assert.match(String(r.positionsNote), /not read here/);
});

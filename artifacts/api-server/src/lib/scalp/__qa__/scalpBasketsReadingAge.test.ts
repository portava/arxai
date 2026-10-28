// Position Manager reading age. The live ledger filter only drops rows more
// than 90s older than the NEWEST row, so when the bridge stops syncing every
// row is equally old and all of them pass: hours-old positions, open P/L and
// stops were returned as the account now, with no time on them. The response
// now says when the bridge last reported the positions shown and flags a
// reading older than 90 seconds as stale.
//
// Paper / no account: the Position Manager reads live and demo MT5 positions
// only. A Paper account's positions are never read, so its empty list is
// reported as not read (with why), never as a measured "no open positions".
//
// Stubbed: the database handle, the mode scope, the live ledger, the scalp
// inputs and the journal. The real basket service runs. No network, no broker.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/lib/scalp/__qa__/scalpBasketsReadingAge.test.ts

import { mock, test } from "node:test";
import assert from "node:assert/strict";

const database = await import("@workspace/db");
function chain(rows: unknown[]): Record<string, unknown> {
  const q: Record<string, unknown> = {};
  const self = () => q;
  q.from = self; q.where = self; q.orderBy = self; q.limit = self; q.values = self;
  q.onConflictDoUpdate = self; q.onConflictDoNothing = self; q.set = self;
  q.then = (resolve: (v: unknown[]) => unknown) => Promise.resolve(rows).then(resolve);
  return q;
}
mock.module("@workspace/db", {
  namedExports: { ...database, db: { select: () => chain([]), insert: () => chain([]), update: () => chain([]) } },
});

let mode = "LIVE_SHARED";
const realScope = await import("../../modeScope/getUserModeScope.js");
mock.module("../../modeScope/getUserModeScope.js", {
  namedExports: { ...realScope, getUserModeScope: async () => ({ currentAccountMode: mode }) },
});

let ledgerRows: Record<string, unknown>[] = [];
const realLedger = await import("../../positions/ledger.js");
mock.module("../../positions/ledger.js", {
  namedExports: { ...realLedger, livePositionLedger: { read: async () => ledgerRows } },
});

let demoState: Record<string, unknown> | null = null;
const realReader = await import("../../brokerHub/mt5StateReader.js");
mock.module("../../brokerHub/mt5StateReader.js", {
  namedExports: { ...realReader, readLatestUserMt5State: async () => demoState },
});

const realJournal = await import("../scalpJournalService.js");
mock.module("../scalpJournalService.js", {
  namedExports: { ...realJournal, recordScalpBasketsObservation: async () => {} },
});

const realInputs = await import("../scalpServiceInputs.js");
mock.module("../scalpServiceInputs.js", {
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

const { getScalpBaskets, getAddOnCheck } = await import("../scalpManageService.js");

function liveRow(ticket: string, syncedAt: Date | null): Record<string, unknown> {
  return {
    userId: 41, brokerTicket: ticket, symbol: "EURUSD", side: "BUY", volume: "0.10",
    entryPrice: "1.10000", currentPrice: "1.10100", floatingPl: "10.00", stopLoss: "1.09500",
    takeProfit: null, openedAt: new Date(Date.now() - 4 * 3_600_000), closedAt: null,
    lastSyncedAt: syncedAt,
  };
}

test("live: positions the bridge last reported 3 hours ago are flagged stale with their time", async () => {
  mode = "LIVE_SHARED";
  const threeHoursAgo = new Date(Date.now() - 3 * 3_600_000);
  ledgerRows = [liveRow("1", threeHoursAgo), liveRow("2", threeHoursAgo)];
  const r = await getScalpBaskets(41, {});
  assert.equal(r.baskets.length, 1, "the basket is still listed (the reading is what we have)");
  assert.equal(r.positionsStale, true, "3-hour-old positions were returned as current");
  assert.equal(r.positionsAsOf, threeHoursAgo.toISOString());
});

test("live: a just-reported book is current and carries its reading time", async () => {
  mode = "LIVE_SHARED";
  const justNow = new Date(Date.now() - 2_000);
  ledgerRows = [liveRow("1", justNow)];
  const r = await getScalpBaskets(41, {});
  assert.equal(r.positionsStale, false);
  assert.equal(r.positionsAsOf, justNow.toISOString());
});

test("live: the as-of time is the oldest leg's reading", async () => {
  mode = "LIVE_SHARED";
  const older = new Date(Date.now() - 60_000);
  const newer = new Date(Date.now() - 1_000);
  ledgerRows = [liveRow("1", newer), liveRow("2", older)];
  const r = await getScalpBaskets(41, {});
  assert.equal(r.positionsAsOf, older.toISOString());
  assert.equal(r.positionsStale, false);
});

test("live: a position with no recorded reading time is not current", async () => {
  mode = "LIVE_SHARED";
  ledgerRows = [liveRow("1", null)];
  const r = await getScalpBaskets(41, {});
  assert.equal(r.baskets.length, 1);
  assert.equal(r.positionsStale, true);
  assert.equal(r.positionsAsOf, null);
});

test("demo: the reading time is the user's last mt5 sync", async () => {
  mode = "DEMO";
  const tenMinAgo = new Date(Date.now() - 10 * 60_000);
  demoState = {
    id: 1, userId: 41, lastSyncAt: tenMinAgo,
    positions: [{ ticket: 9, symbol: "EURUSD", side: "BUY", lot: 0.1, openPrice: 1.1, currentPrice: 1.101, profit: 10 }],
  };
  const r = await getScalpBaskets(41, {});
  assert.equal(r.positionsStale, true);
  assert.equal(r.positionsAsOf, tenMinAgo.toISOString());
});

test("no positions shown: nothing is flagged stale", async () => {
  mode = "LIVE_SHARED";
  ledgerRows = [];
  const r = await getScalpBaskets(41, {});
  assert.equal(r.baskets.length, 0);
  assert.equal(r.positionsStale, false);
  assert.equal(r.positionsAsOf, null);
});

test("paper: positions are reported as not read, not as none", async () => {
  mode = "PAPER";
  const r = await getScalpBaskets(41, {});
  assert.equal(r.accountMode, "PAPER");
  assert.deepEqual(r.baskets, []);
  assert.equal(r.positionsMeasured, false, "a Paper book nobody read was reported as measured");
  assert.match(String(r.positionsNote), /Paper mode.*live and demo MT5 positions only/);
  const a = await getAddOnCheck(41, { symbol: "EURUSD", direction: "BUY" });
  assert.equal(a.hasOpenBasket, false);
  assert.equal(a.positionsMeasured, false);
});

test("no account: positions are reported as not read", async () => {
  mode = "NONE";
  const r = await getScalpBaskets(41, {});
  assert.equal(r.accountMode, "NONE");
  assert.equal(r.positionsMeasured, false);
  assert.match(String(r.positionsNote), /No live or demo account is active/);
});

test("live: a read, empty book is a measured none", async () => {
  mode = "LIVE_SHARED";
  ledgerRows = [];
  const r = await getScalpBaskets(41, {});
  assert.equal(r.positionsMeasured, true);
  assert.equal(r.positionsNote, null);
});

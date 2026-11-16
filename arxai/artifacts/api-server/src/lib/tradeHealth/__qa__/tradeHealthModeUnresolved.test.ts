// When the account's mode could not be read, getUserModeScope returns the
// PAPER fallback with modeResolved:false. buildTradeHealthForUser ignored that
// flag: includeLive and includeDemo were both false, no position was read,
// positionsMeasured was true and the summary was the engine's empty-book line
// "You have no open positions to monitor right now." — while Open Live
// Positions told the same trader "Do not assume you are flat". A fallback row
// filter is not a reading of the book.
//
// Stubbed: the database handle, the mode scope, the live ledger and the
// per-user mt5_state read. The real service and engine run. No network.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/lib/tradeHealth/__qa__/tradeHealthModeUnresolved.test.ts

import { mock, test } from "node:test";
import assert from "node:assert/strict";

const database = await import("@workspace/db");
function chain(rows: unknown[]): Record<string, unknown> {
  const q: Record<string, unknown> = {};
  const self = () => q;
  q.from = self; q.where = self; q.groupBy = self; q.orderBy = self; q.limit = self; q.innerJoin = self; q.leftJoin = self;
  q.then = (resolve: (v: unknown[]) => unknown) => Promise.resolve(rows).then(resolve);
  return q;
}
mock.module("@workspace/db", { namedExports: { ...database, db: { select: () => chain([]) } } });

const realReader = await import("../../brokerHub/mt5StateReader.js");
mock.module("../../brokerHub/mt5StateReader.js", {
  namedExports: { ...realReader, readLatestUserMt5State: async () => null },
});

const MODE_NOTE = "The account's trading mode could not be read (tried 09:05 UTC), so rows here are filtered as PAPER, the safest scope. The account may not be in PAPER mode.";
const state: { resolved: boolean } = { resolved: false };
const realScope = await import("../../modeScope/getUserModeScope.js");
mock.module("../../modeScope/getUserModeScope.js", {
  namedExports: {
    ...realScope,
    getUserModeScope: async (userId: number) => ({
      userId, currentAccountMode: "PAPER", liveExecutionArmed: false, sharedMasterAttached: false,
      isAdmin: false, primaryDataDomain: "paper",
      modeResolved: state.resolved, modeNote: state.resolved ? null : MODE_NOTE,
    }),
  },
});

const realLedger = await import("../../positions/ledger.js");
mock.module("../../positions/ledger.js", {
  namedExports: { ...realLedger, livePositionLedger: { read: async () => [] } },
});

const { buildTradeHealthForUser } = await import("../tradeHealthService.js");

test("mode not read: the book is not reported as measured, and the summary is not 'no open positions'", async () => {
  state.resolved = false;
  const r = await buildTradeHealthForUser({ userId: 41, isAdmin: false, chartSymbol: null, nowMs: Date.now() });
  assert.equal(r.positionsMeasured, false, "a fallback row filter is not a reading of the book");
  assert.doesNotMatch(r.report.summary, /no open positions/i);
  assert.match(r.report.summary, /could not be read/);
  assert.match(r.report.summary, /Do not assume you are flat/);
  assert.ok(r.positionsNote, "the note says why");
  assert.match(r.positionsNote!, /trading mode could not be read/);
  assert.match(r.positionsNote!, /Do not assume you are flat; check MT5 directly/);
});

test("mode read as PAPER: an empty broker book is still measured", async () => {
  state.resolved = true;
  const r = await buildTradeHealthForUser({ userId: 41, isAdmin: false, chartSymbol: null, nowMs: Date.now() });
  assert.equal(r.positionsMeasured, true);
  assert.equal(r.positionsNote, null);
});

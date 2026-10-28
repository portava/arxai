// Scalp journal close truth. A journal entry is a scalp's whole lifecycle,
// and its review is a statement about how the scalp ended:
//  - closing the oldest leg of a still-open basket is a partial close, not a
//    closed scalp. It must not finalize the entry as Win/Loss and start a new
//    one (the basket key carries the first leg's open time, so it changes).
//
// Stubbed: the database handle (a recorder) and the live-position ledger. The
// real journal service runs. No network, no broker.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/lib/scalp/__qa__/scalpJournalCloseTruth.test.ts

import { mock, test } from "node:test";
import assert from "node:assert/strict";

const database = await import("@workspace/db");
const journalTable = database.scalpJournalEntriesTable;

type Op = { kind: "insert" | "update"; table: unknown; values: Record<string, unknown> };
const ops: Op[] = [];
let openRows: Record<string, unknown>[] = [];

function selectChain(): Record<string, unknown> {
  let table: unknown = null;
  let limited = false;
  const q: Record<string, unknown> = {};
  q.from = (t: unknown) => { table = t; return q; };
  q.where = () => q;
  q.orderBy = () => q;
  q.for = () => q;
  q.limit = () => { limited = true; return q; };
  // The OPEN-entries read returns the seeded rows; a by-key lookup (limit 1)
  // finds nothing, as for a key the journal has never stored.
  q.then = (resolve: (v: unknown[]) => unknown) =>
    Promise.resolve(table === journalTable && !limited ? openRows : []).then(resolve);
  return q;
}
function writeChain(kind: Op["kind"], table: unknown): Record<string, unknown> {
  const op: Op = { kind, table, values: {} };
  const q: Record<string, unknown> = {};
  q.values = (v: Record<string, unknown>) => { op.values = v; ops.push(op); return q; };
  q.set = (v: Record<string, unknown>) => { op.values = v; ops.push(op); return q; };
  q.where = () => q;
  q.onConflictDoNothing = () => q;
  q.returning = () => q;
  q.then = (resolve: (v: unknown[]) => unknown) => Promise.resolve([{ id: 1 }]).then(resolve);
  return q;
}
const fakeDb: Record<string, unknown> = {
  select: () => selectChain(),
  insert: (t: unknown) => writeChain("insert", t),
  update: (t: unknown) => writeChain("update", t),
};
fakeDb.transaction = async (cb: (tx: unknown) => Promise<unknown>) => cb(fakeDb);
mock.module("@workspace/db", { namedExports: { ...database, db: fakeDb } });

let closedLedgerRows: Record<string, unknown>[] = [];
const realLedger = await import("../../positions/ledger.js");
mock.module("../../positions/ledger.js", {
  namedExports: { ...realLedger, livePositionLedger: { read: async () => closedLedgerRows } },
});

const { recordScalpBasketsObservation } = await import("../scalpJournalService.js");
type Snapshot = Parameters<typeof recordScalpBasketsObservation>[2][number];

const T1 = Date.parse("2026-10-28T10:00:00Z");
const T2 = Date.parse("2026-10-28T10:02:00Z");

function openEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 7, userId: 41, accountMode: "LIVE_SHARED", symbol: "EURUSD", displayName: "EUR/USD",
    assetClass: null, isSynthetic: false, direction: "BUY", timeframe: "M5",
    basketKey: `LIVE_SHARED|EURUSD|BUY|${T1}`, legTickets: ["t1", "t2", "t3"],
    entryCount: 3, addOnCount: 2, flameStageAtEntry: "ACTIVE", entryTimingAtEntry: "CLEAN",
    maxExitUrgency: "NONE", lastFlameStage: "ACTIVE", flameContinued: true,
    lastFloatingPl: 4.2, lastCurrentPrice: 1.1012, spreadPointsAtEntry: 8,
    flameAgeAtEntry: 2, scoreAtEntry: 70, status: "OPEN", result: "OPEN",
    ...over,
  };
}

function snapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    accountMode: "LIVE_SHARED", symbol: "EURUSD", displayName: "EUR/USD", assetClass: null,
    isSynthetic: false, direction: "BUY", timeframe: "M5", scalpMode: null, setupType: null,
    basketKey: `LIVE_SHARED|EURUSD|BUY|${T2}`, entryCount: 2, addOnCount: 1,
    averageEntry: 1.1, breakEvenPrice: 1.1, scoreAtEntry: 65, flameStageAtEntry: "ACTIVE",
    flameAgeAtEntry: 3, entryTimingAtEntry: "CLEAN", chaseRiskAtEntry: "LOW",
    spreadPointsAtEntry: 8, executionLatencyAtEntry: 2, htfContextAtEntry: null,
    whyNowAtEntry: null, maxExitUrgency: "NONE", flameContinued: true,
    lastFloatingPl: 3.1, lastCurrentPrice: 1.1011, openedAtMs: T2,
    legTickets: ["t2", "t3"],
    ...over,
  };
}

function journalWrites(): Op[] {
  return ops.filter((o) => o.table === journalTable);
}

test("partial close: closing the oldest leg of an open basket does not finalize the scalp", async () => {
  ops.length = 0;
  openRows = [openEntry()];
  closedLedgerRows = [{ brokerTicket: "t1", closedAt: new Date(), floatingPl: "5.00", currentPrice: "1.1010" }];
  await recordScalpBasketsObservation(41, "LIVE_SHARED", [snapshot()]);

  const writes = journalWrites();
  assert.ok(!writes.some((o) => o.values["status"] === "CLOSED"),
    "the still-open basket was finalized as a closed scalp");
  assert.ok(!writes.some((o) => o.kind === "insert"),
    "a second journal entry was started for the same open basket");
  const upd = writes.find((o) => o.kind === "update");
  assert.ok(upd, "the open entry was not updated");
  assert.deepEqual(upd.values["legTickets"], ["t1", "t2", "t3"],
    "the closed leg's ticket was dropped, so its result would be missing at the final close");
  assert.equal(upd.values["entryCount"], 2, "entryCount is the legs open now");
  assert.equal(upd.values["addOnCount"], 2, "the add-ons already made are kept");
  assert.ok(!ops.some((o) => o.table === database.scalpSymbolPersonalityTable),
    "a partial close was folded into the personality as a closed trade");
});

test("partial close: a basket on another symbol sharing no ticket is still a new scalp", async () => {
  ops.length = 0;
  openRows = [openEntry()];
  closedLedgerRows = [];
  await recordScalpBasketsObservation(41, "LIVE_SHARED", [snapshot({
    symbol: "GBPUSD", basketKey: `LIVE_SHARED|GBPUSD|BUY|${T2}`, legTickets: ["g1"],
  })]);
  const writes = journalWrites();
  assert.ok(writes.some((o) => o.kind === "insert" && o.values["symbol"] === "GBPUSD"));
  assert.ok(writes.some((o) => o.values["status"] === "CLOSED"),
    "the EURUSD basket that is gone should still be finalized");
});

test("partial close: a basket whose every leg is gone is finalized", async () => {
  ops.length = 0;
  openRows = [openEntry()];
  closedLedgerRows = [];
  await recordScalpBasketsObservation(41, "LIVE_SHARED", []);
  assert.ok(journalWrites().some((o) => o.values["status"] === "CLOSED"));
});

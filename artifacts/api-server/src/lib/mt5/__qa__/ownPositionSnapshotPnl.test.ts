// Regression: a USER_OWNED_MT5 trader's EA pushes positions every ~5 s with
// the broker's floating profit, but applyOwnPositionSnapshot stored only
// lot/SL/TP/lastSyncedAt and discarded `profit`. Nothing else writes
// unrealizedProfitLoss for these rows, so /me/trades/open emitted
// unrealizedPnl null + waitingForSync true forever ("syncing…") while the
// cockpit strip summed the nulls into a green "Open P/L +$0.00".
import { beforeEach, test, mock } from "node:test";
import assert from "node:assert/strict";
process.env.DATABASE_URL = "postgres://qa:qa@127.0.0.1:1/offline_never_connects";
const database = await import("@workspace/db");
mock.method(database.pool, "query", () => { throw new Error("Unexpected database access"); });
mock.method(database.pool, "connect", () => { throw new Error("Unexpected database access"); });

const ledger = await import("../../positions/ledger.js");
let rows: Array<{ id: number; ticket: string | null; status: string }> = [];
const updates: Array<Record<string, unknown>> = [];
const inserts: Array<Record<string, unknown>> = [];
mock.module("../../positions/ledger.js", {
  namedExports: {
    ...ledger,
    demoPositionLedger: { ...ledger.demoPositionLedger, select: async () => rows },
    demoPositionWriter: {
      ...ledger.demoPositionWriter,
      update: async (values: Record<string, unknown>) => { updates.push(values); },
      insert: async (values: Record<string, unknown>) => { inserts.push(values); },
    },
  },
});
let governedTickets: string[] = [];
const fakeDb = {
  select: () => ({ from: () => ({ where: async () => governedTickets.map((t) => ({ t })) }) }),
};
mock.module("@workspace/db", { namedExports: { ...database, db: fakeDb } });

const { applyOwnPositionSnapshot } = await import("../executionReconciler.js");

beforeEach(() => { rows = []; updates.length = 0; inserts.length = 0; governedTickets = []; });

test("a tracked position's broker-reported profit is stored as its unrealized P/L", async () => {
  rows = [{ id: 11, ticket: "5001", status: "OPEN" }, { id: 12, ticket: "5002", status: "OPEN" }];
  const now = new Date("2026-10-28T12:00:00Z");
  const n = await applyOwnPositionSnapshot(7, [
    { ticket: 5001, lot: 0.5, sl: 1.08, tp: 1.1, profit: -42.1 },
    { ticket: 5002, lot: 0.2, sl: null, tp: null, profit: 7.3 },
  ], now);
  assert.equal(n, 2);
  assert.equal(updates[0]!.unrealizedProfitLoss, -42.1);
  assert.equal(updates[1]!.unrealizedProfitLoss, 7.3);
  assert.equal(updates[0]!.lastSyncedAt, now);
});

test("a push without profit clears the stored figure instead of keeping a stale one as current", async () => {
  rows = [{ id: 11, ticket: "5001", status: "OPEN" }];
  await applyOwnPositionSnapshot(7, [{ ticket: 5001, lot: 0.5, sl: 1.08, tp: 1.1 }]);
  assert.ok("unrealizedProfitLoss" in updates[0]!);
  assert.equal(updates[0]!.unrealizedProfitLoss, null);
});

test("a newly tracked governed fill starts with the broker-reported profit", async () => {
  governedTickets = ["6001"];
  await applyOwnPositionSnapshot(7, [
    { ticket: 6001, symbol: "EURUSD", side: "BUY", lot: 1, entry: 1.085, sl: 1.08, tp: 1.1, profit: 15 },
  ]);
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0]!.unrealizedProfitLoss, 15);
});

// /me/trades/open card rule: the stored broker profit is shown once observed,
// without waiting for a currentPrice the bridge push never carries; a stale or
// missing observation is withheld.
const { ownPositionPnlView } = await import("../ownPositionPnl.js");

test("a fresh broker profit is shown and the card is not 'syncing'", () => {
  const now = Date.parse("2026-10-28T12:00:05Z");
  const v = ownPositionPnlView({ unrealizedProfitLoss: -42.1, lastSyncedAt: new Date("2026-10-28T12:00:00Z") }, now);
  assert.deepEqual(v, { unrealizedPnl: -42.1, waitingForSync: false, pnlObservedAt: "2026-10-28T12:00:00.000Z" });
});

test("no stored profit stays waiting for sync", () => {
  const v = ownPositionPnlView({ unrealizedProfitLoss: null, lastSyncedAt: new Date() }, Date.now());
  assert.equal(v.unrealizedPnl, null);
  assert.equal(v.waitingForSync, true);
});

test("a profit last reported over a minute ago is withheld, not shown as current", () => {
  const now = Date.parse("2026-10-28T12:05:00Z");
  const v = ownPositionPnlView({ unrealizedProfitLoss: 7.3, lastSyncedAt: new Date("2026-10-28T12:00:00Z") }, now);
  assert.equal(v.unrealizedPnl, null);
  assert.equal(v.waitingForSync, true);
  assert.equal(v.pnlObservedAt, "2026-10-28T12:00:00.000Z");
});

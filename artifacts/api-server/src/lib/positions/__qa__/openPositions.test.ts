// Real-DB contract tests for the canonical open-position read model: both
// venues, the three named "open" bases (and their equivalence with the legacy
// inline predicates the migrated callers used), account-mode scoping, tenant
// isolation with colliding broker tickets, closed/reconciled rows excluded,
// filters, ordering and transaction pass-through.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { db, usersTable, arxLivePositionsTable, livePositionsTable } from "@workspace/db";
import {
  livePositionLedger,
  demoPositionLedger,
  livePositionWriter,
  demoPositionWriter,
  livePositionColumns as live,
  demoPositionColumns as demo,
} from "../ledger.js";
import { openLiveExposureCondition } from "../../live/livePositionExposure.js";
import {
  countOpenPositions,
  openPositionVenuesForMode,
  readOpenPositions,
} from "../openPositions.js";

let alice = 0,
  bob = 0;
const T = `qa-open-${process.pid}`;
const tickets = { open: T, closed: `${T}-closed`, ghost: `${T}-ghost`, pending: `${T}-pending`, other: `${T}-gbp` };
const hourAgo = new Date(Date.now() - 3_600_000);

async function seed(userId: number, bridgeConnectionId: number) {
  await livePositionWriter.insert({
    userId, bridgeConnectionId, brokerTicket: tickets.open, symbol: "EURUSD", side: "BUY", volume: 0.1,
    entryPrice: 1.1, currentPrice: 1.101, floatingPl: 10, stopLoss: 1.09, takeProfit: 1.12,
    openedAt: hourAgo, sourceCommandId: `cmd-${userId}`,
  });
  await livePositionWriter.insert({
    userId, bridgeConnectionId: bridgeConnectionId + 1, brokerTicket: tickets.other, symbol: "GBPUSD", side: "SELL",
    volume: 0.2, entryPrice: 1.3, floatingPl: -4, openedAt: new Date(),
  });
  await livePositionWriter.insert({
    userId, bridgeConnectionId, brokerTicket: tickets.closed, symbol: "EURUSD", side: "BUY", volume: 0.1,
    entryPrice: 1.1, floatingPl: 3, openedAt: hourAgo, closedAt: new Date(),
  });
  // Operator-reconciled orphan: closed_at never stamped, reconcile_state set.
  await livePositionWriter.insert({
    userId, bridgeConnectionId, brokerTicket: tickets.ghost, symbol: "EURUSD", side: "SELL", volume: 0.3,
    entryPrice: 1.1, floatingPl: -7, openedAt: hourAgo, reconcileState: "IGNORED",
  });
  await demoPositionWriter.insert({
    userId, brokerPositionId: tickets.open, symbol: "EURUSD", direction: "BUY", lotSize: 0.1, entryPrice: 1.1,
    currentPrice: 1.102, unrealizedProfitLoss: 20, stopLoss: 1.09, status: "OPEN", openedAt: hourAgo,
  });
  await demoPositionWriter.insert({
    userId, brokerPositionId: tickets.pending, symbol: "EURUSD", direction: "SELL", lotSize: 0.2, entryPrice: 1.1,
    status: "SYNC_PENDING",
  });
  await demoPositionWriter.insert({
    userId, brokerPositionId: tickets.closed, symbol: "EURUSD", direction: "BUY", lotSize: 0.1, entryPrice: 1.1,
    status: "CLOSED", closedAt: new Date(),
  });
}

before(async () => {
  for (const name of ["alice", "bob"]) {
    const [u] = await db
      .insert(usersTable)
      .values({ email: `qa+openpos-${name}-${process.pid}@arx.test`, name, role: "USER", isSystemUser: true })
      .returning();
    if (name === "alice") alice = u!.id;
    else bob = u!.id;
  }
  await seed(alice, 900_001);
  await seed(bob, 900_101);
});

after(async () => {
  const ids = [alice, bob].filter(Boolean);
  if (!ids.length) return;
  await db.delete(arxLivePositionsTable).where(inArray(arxLivePositionsTable.userId, ids));
  await db.delete(livePositionsTable).where(inArray(livePositionsTable.userId, ids));
  await db.delete(usersTable).where(inArray(usersTable.id, ids));
});

const sorted = (xs: Array<string | null>) => [...xs].sort();

test("each basis returns exactly the rows the legacy inline predicates returned", async () => {
  const ids = (rows: Array<{ id: number }>) => rows.map((r) => r.id).sort((a, b) => a - b);
  // LIVE EXPOSURE = openLiveExposureCondition (unified feed, guardian, wallet views).
  assert.deepEqual(
    ids(await readOpenPositions({ userId: alice, venue: "LIVE", basis: "EXPOSURE" })),
    ids(await livePositionLedger.read({ where: openLiveExposureCondition(alice) })),
  );
  // LIVE UNCLOSED = user AND closed_at IS NULL (Risk Governor, assistant lookups).
  assert.deepEqual(
    ids(await readOpenPositions({ userId: alice, venue: "LIVE", basis: "UNCLOSED" })),
    ids(await livePositionLedger.read({ where: and(eq(live.userId, alice), isNull(live.closedAt)) })),
  );
  // DEMO EXPOSURE / UNCLOSED = status <> 'CLOSED'; CONFIRMED_OPEN = status = 'OPEN'.
  const notClosed = ids(await demoPositionLedger.read({ where: and(eq(demo.userId, alice), ne(demo.status, "CLOSED")) }));
  assert.deepEqual(ids(await readOpenPositions({ userId: alice, venue: "DEMO", basis: "EXPOSURE" })), notClosed);
  assert.deepEqual(ids(await readOpenPositions({ userId: alice, venue: "DEMO", basis: "UNCLOSED" })), notClosed);
  assert.deepEqual(
    ids(await readOpenPositions({ userId: alice, venue: "DEMO", basis: "CONFIRMED_OPEN" })),
    ids(await demoPositionLedger.read({ where: and(eq(demo.userId, alice), eq(demo.status, "OPEN")) })),
  );
});

test("closed rows never appear; reconciled ghosts only under UNCLOSED", async () => {
  const live = async (basis: "EXPOSURE" | "UNCLOSED" | "CONFIRMED_OPEN") =>
    sorted((await readOpenPositions({ userId: alice, venue: "LIVE", basis })).map((p) => p.ticket));
  assert.deepEqual(await live("EXPOSURE"), sorted([tickets.open, tickets.other]));
  assert.deepEqual(await live("CONFIRMED_OPEN"), sorted([tickets.open, tickets.other]));
  assert.deepEqual(await live("UNCLOSED"), sorted([tickets.open, tickets.other, tickets.ghost]));
  const demoTickets = async (basis: "EXPOSURE" | "CONFIRMED_OPEN") =>
    sorted((await readOpenPositions({ userId: alice, venue: "DEMO", basis })).map((p) => p.ticket));
  assert.deepEqual(await demoTickets("EXPOSURE"), sorted([tickets.open, tickets.pending]));
  assert.deepEqual(await demoTickets("CONFIRMED_OPEN"), [tickets.open]);
  const ghost = (await readOpenPositions({ userId: alice, venue: "LIVE", basis: "UNCLOSED" })).find((p) => p.ticket === tickets.ghost);
  assert.equal(ghost?.status, "IGNORED");
  assert.equal(await countOpenPositions({ userId: alice, venue: "ALL" }), 4);
  assert.equal(await countOpenPositions({ userId: alice, venue: "LIVE", basis: "UNCLOSED" }), 3);
});

test("both venues normalise to one shape; ALL lists LIVE before DEMO", async () => {
  const all = await readOpenPositions({ userId: alice, venue: "ALL", symbol: "EURUSD", basis: "CONFIRMED_OPEN" });
  assert.deepEqual(all.map((p) => p.venue), ["LIVE", "DEMO"]);
  const [l, d] = all;
  assert.ok(l && l.venue === "LIVE" && d && d.venue === "DEMO");
  assert.equal(l.ticket, tickets.open);
  assert.equal(l.side, "BUY");
  assert.equal(l.lots, 0.1);
  assert.equal(l.entryPrice, 1.1);
  assert.equal(l.stopLoss, 1.09);
  assert.equal(l.takeProfit, 1.12);
  assert.equal(l.currentPrice, 1.101);
  assert.equal(l.floatingPnl, 10);
  assert.equal(l.sourceCommandId, `cmd-${alice}`);
  assert.equal(l.bridgeConnectionId, 900_001);
  assert.equal(l.status, "OPEN");
  assert.ok(l.observedAt instanceof Date && l.recordedAt instanceof Date);
  assert.equal(l.openedAt?.getTime(), hourAgo.getTime());
  assert.equal(l.row.brokerTicket, l.ticket);
  assert.equal(d.ticket, tickets.open);
  assert.equal(d.side, "BUY");
  assert.ok(Math.abs(d.lots - 0.1) < 1e-6);
  assert.ok(Math.abs((d.floatingPnl ?? 0) - 20) < 1e-6);
  assert.equal(d.sourceCommandId, null);
  assert.equal(d.bridgeConnectionId, null);
  assert.equal(d.status, "OPEN");
  assert.equal(d.userId, alice);
});

test("colliding tickets stay tenant-scoped on both venues", async () => {
  for (const [owner, other] of [[alice, bob], [bob, alice]] as const) {
    const rows = await readOpenPositions({ userId: owner, venue: "ALL", basis: "UNCLOSED", tickets: [tickets.open, tickets.ghost] });
    assert.equal(rows.length, 3);
    assert.ok(rows.every((p) => p.userId === owner && p.row.userId === owner));
    const otherIds = new Set((await readOpenPositions({ userId: other, venue: "ALL", basis: "UNCLOSED" })).map((p) => `${p.venue}:${p.id}`));
    assert.ok(rows.every((p) => !otherIds.has(`${p.venue}:${p.id}`)));
  }
  assert.equal(await countOpenPositions({ userId: bob, venue: "LIVE", tickets: [tickets.open] }), 1);
  assert.deepEqual(await readOpenPositions({ userId: alice, venue: "ALL", tickets: [] }), []);
  assert.equal(await countOpenPositions({ userId: alice, venue: "ALL", tickets: [] }), 0);
  await assert.rejects(() => readOpenPositions({ userId: 0, venue: "LIVE" }), /positive integer userId/);
  await assert.rejects(() => countOpenPositions({ userId: Number.NaN, venue: "DEMO" }), /positive integer userId/);
});

test("mode scope drops venues the account mode does not show", async () => {
  assert.deepEqual(openPositionVenuesForMode("LIVE_SHARED"), ["LIVE"]);
  assert.deepEqual(openPositionVenuesForMode("DEMO"), ["DEMO"]);
  assert.deepEqual(openPositionVenuesForMode("PAPER"), []);
  const venues = async (mode: "LIVE_SHARED" | "DEMO" | "PAPER") =>
    [...new Set((await readOpenPositions({ userId: alice, venue: "ALL", modeScope: { currentAccountMode: mode } })).map((p) => p.venue))];
  assert.deepEqual(await venues("LIVE_SHARED"), ["LIVE"]);
  assert.deepEqual(await venues("DEMO"), ["DEMO"]);
  assert.deepEqual(await venues("PAPER"), []);
  assert.deepEqual(await readOpenPositions({ userId: alice, venue: "LIVE", modeScope: { currentAccountMode: "DEMO" } }), []);
  assert.equal(await countOpenPositions({ userId: alice, venue: "DEMO", modeScope: { currentAccountMode: "LIVE_SHARED" } }), 0);
});

test("filters, ordering, limit and bridge scope", async () => {
  const gbp = await readOpenPositions({ userId: alice, venue: "LIVE", symbol: "GBPUSD" });
  assert.deepEqual(gbp.map((p) => p.ticket), [tickets.other]);
  const byId = await readOpenPositions({ userId: alice, venue: "LIVE" });
  assert.deepEqual(byId.map((p) => p.id), [...byId.map((p) => p.id)].sort((a, b) => a - b));
  const newest = await readOpenPositions({ userId: alice, venue: "LIVE", order: "openedAtDesc" });
  assert.equal(newest[0]!.ticket, tickets.other);
  assert.equal((await readOpenPositions({ userId: alice, venue: "LIVE", order: "openedAtDesc", limit: 1 })).length, 1);
  const bridge = await readOpenPositions({ userId: alice, venue: "LIVE", bridgeConnectionId: 900_001, basis: "UNCLOSED" });
  assert.deepEqual(sorted(bridge.map((p) => p.ticket)), sorted([tickets.open, tickets.ghost]));
  assert.equal(await countOpenPositions({ userId: alice, venue: "LIVE", bridgeConnectionId: 900_001 }), 1);
  await assert.rejects(() => readOpenPositions({ userId: alice, venue: "ALL", bridgeConnectionId: 1 }), /LIVE positions only/);
});

test("a supplied transaction is used, not replaced by the global db", async () => {
  const txTicket = `${T}-tx`;
  await assert.rejects(
    db.transaction(async (tx) => {
      await livePositionWriter.insert({
        userId: alice, bridgeConnectionId: 900_001, brokerTicket: txTicket, symbol: "EURUSD", side: "BUY",
        volume: 0.1, entryPrice: 1.1, openedAt: new Date(),
      }, false, tx);
      assert.equal(await countOpenPositions({ userId: alice, venue: "LIVE", tickets: [txTicket], executor: tx }), 1);
      assert.equal((await readOpenPositions({ userId: alice, venue: "LIVE", tickets: [txTicket], executor: tx })).length, 1);
      throw new Error("rollback");
    }),
    /rollback/,
  );
  assert.equal(await countOpenPositions({ userId: alice, venue: "LIVE", tickets: [txTicket] }), 0);
});

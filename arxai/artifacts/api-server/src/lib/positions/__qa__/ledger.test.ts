// Real-DB contract tests: duplicate broker tickets across tenants, explicit
// projections, CAS, transaction rollback, both joins and raw lock-scoped reads.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  pool,
  usersTable,
  arxLivePositionsTable,
  livePositionsTable,
  sharedTradeAttributionTable,
  tradePoolAllocationsTable,
} from "@workspace/db";
import {
  livePositionLedger,
  demoPositionLedger,
  livePositionWriter,
  demoPositionWriter,
  livePositionColumns as live,
  demoPositionColumns as demo,
  reconcileLivePositionMetadata,
  readAttributedLivePositions,
  readOpenLivePositionsWithPools,
  readLiveFloatingLoss,
  readOrphanLivePositions,
  countDemoPositions,
} from "../ledger.js";
import { openLiveExposureCondition } from "../../live/livePositionExposure.js";

let alice = 0,
  bob = 0;
const ticket = `qa-ledger-${process.pid}`;
const liveRow = (userId: number, brokerTicket = ticket) => ({
  userId,
  brokerTicket,
  bridgeConnectionId: 1,
  symbol: "EURUSD",
  side: "BUY",
  volume: 0.1,
  entryPrice: 1.1,
  stopLoss: 1.09,
  floatingPl: -5,
  openedAt: new Date(),
});
const demoRow = (userId: number, brokerPositionId = ticket) => ({
  userId,
  brokerPositionId,
  symbol: "EURUSD",
  direction: "BUY",
  lotSize: 0.1,
  entryPrice: 1.1,
  stopLoss: 1.09,
  status: "OPEN",
});
const scope = (userId: number) => and(eq(live.userId, userId), eq(live.brokerTicket, ticket));
const demoScope = (userId: number) => and(eq(demo.userId, userId), eq(demo.brokerPositionId, ticket));

before(async () => {
  for (const name of ["alice", "bob"]) {
    const [u] = await db
      .insert(usersTable)
      .values({ email: `qa+ledger-${name}-${process.pid}@arx.test`, name, role: "USER", isSystemUser: true })
      .returning();
    if (name === "alice") alice = u!.id;
    else bob = u!.id;
  }
  for (const id of [alice, bob]) {
    await livePositionWriter.insert(liveRow(id));
    await demoPositionWriter.insert(demoRow(id));
  }
});
after(async () => {
  const ids = [alice, bob].filter(Boolean);
  if (!ids.length) return;
  await db.delete(sharedTradeAttributionTable).where(inArray(sharedTradeAttributionTable.userId, ids));
  await db.delete(tradePoolAllocationsTable).where(inArray(tradePoolAllocationsTable.userId, ids));
  await db.delete(arxLivePositionsTable).where(inArray(arxLivePositionsTable.userId, ids));
  await db.delete(livePositionsTable).where(inArray(livePositionsTable.userId, ids));
  await db.delete(usersTable).where(inArray(usersTable.id, ids));
});

test("same broker ticket remains tenant-scoped on both schemas", async () => {
  assert.deepEqual(
    (await livePositionLedger.read({ where: scope(alice) })).map((r) => r.userId),
    [alice],
  );
  assert.deepEqual(
    (await demoPositionLedger.read({ where: demoScope(bob) })).map((r) => r.userId),
    [bob],
  );
  await livePositionWriter.update({ stopLoss: 1.095 }, scope(alice));
  await demoPositionWriter.update({ stopLoss: 1.095 }, demoScope(alice));
  assert.equal((await livePositionLedger.read({ where: scope(bob) }))[0]!.stopLoss, 1.09);
  assert.ok(Math.abs((await demoPositionLedger.read({ where: demoScope(bob) }))[0]!.stopLoss! - 1.09) < 1e-6);
});

test("projection, distinct, ordering, grouping and limit are applied inside the ledger", async () => {
  const extra = `${ticket}-extra`;
  await livePositionWriter.insert(liveRow(alice, extra));
  const projection = await livePositionLedger.select(
    { ticket: live.brokerTicket },
    {
      where: eq(live.userId, alice),
      orderBy: [desc(live.id)],
      limit: 1,
    },
  );
  assert.deepEqual(projection, [{ ticket: extra }]);
  const distinct = await livePositionLedger.select(
    { userId: live.userId },
    { where: eq(live.userId, alice), distinct: true },
  );
  assert.deepEqual(distinct, [{ userId: alice }]);
  const grouped = await livePositionLedger.select(
    { owner: live.userId, count: sql<number>`count(*)::int` },
    {
      where: eq(live.userId, alice),
      groupBy: [live.userId],
    },
  );
  assert.deepEqual(grouped, [{ owner: alice, count: 2 }]);
  const demoIds = await demoPositionLedger.select(
    { userId: demo.userId },
    { where: demoScope(alice), distinct: true, limit: 1 },
  );
  assert.deepEqual(demoIds, [{ userId: alice }]);
});

test("duplicate snapshot insert preserves the tenant/ticket conflict target", async () => {
  assert.deepEqual(await demoPositionWriter.insertReturning(demoRow(alice), { id: demo.id }, true), []);
  const rows = await demoPositionLedger.read({ where: demoScope(alice) });
  assert.equal(rows.length, 1);
});

test("compare-and-set refuses a stale absence cycle and keeps returning projections", async () => {
  const miss = await livePositionWriter.updateReturning(
    { closedAt: new Date() },
    and(scope(alice), eq(live.brokerAbsentSnapshotCount, 99)),
    { id: live.id },
  );
  assert.deepEqual(miss, []);
  const hit = await livePositionWriter.updateReturning({ floatingPl: -6 }, scope(alice), {
    ticket: live.brokerTicket,
  });
  assert.deepEqual(hit, [{ ticket }]);
  assert.equal((await livePositionLedger.read({ where: scope(alice) }))[0]!.closedAt, null);
});

test("writes require a predicate and read interfaces expose no mutation or table", async () => {
  await assert.rejects(livePositionWriter.update({ stopLoss: 0 }, undefined), /explicit predicate/);
  await assert.rejects(demoPositionWriter.update({ stopLoss: 0 }, undefined), /explicit predicate/);
  assert.deepEqual(Object.keys(livePositionLedger).sort(), ["read", "select"]);
  assert.deepEqual(Object.keys(demoPositionLedger).sort(), ["read", "select"]);
});

test("supplied transaction owns both reads and writes; rollback leaves both schemas intact", async () => {
  const beforeLive = (await livePositionLedger.read({ where: scope(alice) }))[0]!.stopLoss;
  const beforeDemo = (await demoPositionLedger.read({ where: demoScope(alice) }))[0]!.stopLoss;
  await assert.rejects(
    db.transaction(async (tx) => {
      await livePositionWriter.update({ stopLoss: 1.08 }, scope(alice), tx);
      await demoPositionWriter.update({ stopLoss: 1.08 }, demoScope(alice), tx);
      assert.equal((await livePositionLedger.read({ where: scope(alice) }, tx))[0]!.stopLoss, 1.08);
      assert.ok(
        Math.abs((await demoPositionLedger.read({ where: demoScope(alice) }, tx))[0]!.stopLoss! - 1.08) <
          1e-6,
      );
      throw new Error("QA_ROLLBACK");
    }),
    /QA_ROLLBACK/,
  );
  assert.equal((await livePositionLedger.read({ where: scope(alice) }))[0]!.stopLoss, beforeLive);
  assert.equal((await demoPositionLedger.read({ where: demoScope(alice) }))[0]!.stopLoss, beforeDemo);
});

test("metadata reconciliation ignores protective and ownership fields, and rolls back with audit failure", async () => {
  const [position] = await livePositionLedger.read({ where: scope(alice) });
  const metadata = {
    reconcileState: "EXTERNAL",
    reconcileNote: "QA",
    reconciledByAdminId: null,
    reconciledAt: new Date(),
    stopLoss: 0,
    userId: bob,
    closedAt: new Date(),
  };
  await assert.rejects(
    db.transaction(async (tx) => {
      const [changed] = await reconcileLivePositionMetadata(position!.id, metadata, tx);
      assert.equal(changed!.reconcileState, "EXTERNAL");
      assert.equal(changed!.stopLoss, position!.stopLoss);
      assert.equal(changed!.userId, alice);
      assert.equal(changed!.closedAt, null);
      throw new Error("AUDIT_WRITE_FAILED");
    }),
    /AUDIT_WRITE_FAILED/,
  );
  assert.equal((await livePositionLedger.read({ where: scope(alice) }))[0]!.reconcileState, null);
});

test("both joins match owner AND ticket, without cross-tenant P/L attribution", async () => {
  for (const [owner, allocation] of [
    [alice, 111],
    [bob, 222],
  ]) {
    await db
      .insert(tradePoolAllocationsTable)
      .values({
        userId: owner!,
        brokerTicket: ticket,
        symbol: "EURUSD",
        strategyPoolId: allocation,
        status: "ASSIGNED",
      });
    await db
      .insert(sharedTradeAttributionTable)
      .values({
        userId: owner!,
        virtualAccountId: owner!,
        sharedMasterAccountId: 1,
        masterConnectionId: 1,
        symbol: "EURUSD",
        side: "BUY",
        lotSize: 0.1,
        status: "open",
        mt5PositionTicket: ticket,
      });
  }
  const attributed = await readAttributedLivePositions(alice);
  assert.equal(attributed.length, 1);
  assert.equal(attributed[0]!.virtualAccountId, alice);
  assert.equal(attributed[0]!.pnl, -6);
  const joined = (await readOpenLivePositionsWithPools()).filter((r) => r.pos.brokerTicket === ticket);
  assert.equal(joined.length, 2);
  assert.equal(joined.find((r) => r.pos.userId === alice)!.allocPoolId, 111);
  assert.equal(joined.find((r) => r.pos.userId === bob)!.allocPoolId, 222);
});

test("exposure and lock-scoped raw reads exclude closed/reconciled rows and use the supplied connection", async () => {
  await livePositionWriter.insert({
    ...liveRow(alice, `${ticket}-ghost`),
    floatingPl: -1000,
    reconcileState: "IGNORED",
  });
  await livePositionWriter.insert({
    ...liveRow(alice, `${ticket}-closed`),
    floatingPl: -1000,
    closedAt: new Date(),
  });
  const open = await livePositionLedger.read({ where: openLiveExposureCondition(alice) });
  assert.equal(open.length, 2);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "UPDATE arx_live_positions SET floating_pl = -7 WHERE user_id = $1 AND broker_ticket = $2",
      [alice, ticket],
    );
    const result = await readLiveFloatingLoss(client, alice);
    assert.equal(Number(result.rows[0]!.loss), -12);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
  assert.equal((await livePositionLedger.read({ where: scope(alice) }))[0]!.floatingPl, -6);
  const orphan = (await readOrphanLivePositions()).rows.filter((r) => r.user_id === alice);
  assert.equal(orphan.length, 2);
  assert.ok((await countDemoPositions()) >= 2);
});

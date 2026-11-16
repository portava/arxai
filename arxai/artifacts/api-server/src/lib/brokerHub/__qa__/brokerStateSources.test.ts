// Broker Hub state sources — broker_health_state / broker_health_logs,
// broker_readonly_snapshots / broker_readonly_logs, arx_master_bridge_pool and
// bridge_v2_stream_state, on a real database.
//
// Proves:
//   - the health singleton read is the lowest-id row, deterministically, also
//     inside a transaction, so every caller reads the row the route writes;
//   - a singleton created with defaults starts default-closed (DISCONNECTED,
//     execution off, never evaluated), never a fabricated connected state;
//   - the newest health log is returned first;
//   - read-only snapshot/log reads are scoped to one owner: another user's rows
//     and legacy ownerless rows are never returned, owner 0 matches nothing;
//   - "id" and "createdAt" orderings keep the two callers' semantics;
//   - no snapshot means null status (callers report not connected);
//   - the shared-master pool reader returns the one row for a master (null when
//     none) and sees an over-allocated flag;
//   - Bridge v2 stream reads are user-scoped (null = all users) and the admin
//     trace read is newest-updated first and capped.
//
// Run: pnpm --filter @workspace/api-server run test:broker-hub-state-sources

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { asc, inArray } from "drizzle-orm";
import {
  db,
  brokerHealthLogsTable,
  brokerHealthStateTable,
  brokerReadonlyLogsTable,
  brokerReadonlySnapshotsTable,
  arxMasterBridgePoolTable,
  bridgeV2StreamStateTable,
  usersTable,
  type User,
} from "@workspace/db";
import {
  listBrokerHealthLogs,
  readBrokerHealthState,
  readLatestBrokerHealthLog,
} from "../brokerHealthState.js";
import {
  listOwnerReadOnlyLogs,
  listOwnerReadOnlySnapshots,
  readOwnerLatestReadOnlyStatus,
} from "../readOnlySnapshots.js";
import { anyMasterBridgePoolOverAllocated, readMasterBridgePoolByMaster } from "../masterBridgePoolReader.js";
import { listBridgeV2StreamStates, listRecentBridgeV2StreamStates } from "../bridgeV2StreamState.js";

const EMAILS = ["qa+broker-state-src-a@arx.test", "qa+broker-state-src-b@arx.test"];
const TAG = "qa-broker-state-src";
let a: User;
let b: User;
const stateIds: number[] = [];
// Synthetic master connection ids (no FK on the pool table); negative so they
// can never collide with a real mt5_connection id.
const POOL_MASTERS = [-424201, -424202];

async function cleanup(): Promise<void> {
  if (stateIds.length) await db.delete(brokerHealthStateTable).where(inArray(brokerHealthStateTable.id, stateIds));
  await db.delete(brokerHealthLogsTable).where(inArray(brokerHealthLogsTable.brokerName, [TAG]));
  const users = await db.select({ id: usersTable.id }).from(usersTable).where(inArray(usersTable.email, EMAILS));
  const ids = users.map((u) => u.id);
  if (ids.length) {
    await db.delete(brokerReadonlySnapshotsTable).where(inArray(brokerReadonlySnapshotsTable.userId, ids));
    await db.delete(brokerReadonlyLogsTable).where(inArray(brokerReadonlyLogsTable.userId, ids));
    await db.delete(bridgeV2StreamStateTable).where(inArray(bridgeV2StreamStateTable.userId, ids));
  }
  await db.delete(arxMasterBridgePoolTable).where(inArray(arxMasterBridgePoolTable.masterConnectionId, POOL_MASTERS));
  await db.delete(brokerReadonlySnapshotsTable).where(inArray(brokerReadonlySnapshotsTable.provider, [TAG]));
  await db.delete(brokerReadonlyLogsTable).where(inArray(brokerReadonlyLogsTable.connectorId, [TAG]));
  await db.delete(usersTable).where(inArray(usersTable.email, EMAILS));
}

// Writers live outside the hub (routes/brokerHealth.ts, lib/brokerReadOnly/service.ts);
// the fixtures insert the same way they do.
const insertReadOnlySnapshot = (v: typeof brokerReadonlySnapshotsTable.$inferInsert) => db.insert(brokerReadonlySnapshotsTable).values(v);
const insertReadOnlyLog = (v: typeof brokerReadonlyLogsTable.$inferInsert) => db.insert(brokerReadonlyLogsTable).values(v);
const appendBrokerHealthLog = (v: typeof brokerHealthLogsTable.$inferInsert) => db.insert(brokerHealthLogsTable).values(v);

before(async () => {
  await cleanup();
  [a, b] = await db.insert(usersTable).values(EMAILS.map((email, i) => ({
    email, name: `QA broker state ${i}`, role: "USER", isSystemUser: true,
  }))).returning() as [User, User];
});
after(cleanup);

test("the health singleton is the lowest-id row for every reader, created default-closed", async () => {
  if (!(await readBrokerHealthState())) {
    // Same insert the health route makes on first use.
    const [created] = await db.insert(brokerHealthStateTable).values({}).returning();
    stateIds.push(created!.id);
    const canonical = await readBrokerHealthState();
    assert.equal(canonical?.id, created!.id);
    assert.equal(canonical?.lastStatus, "DISCONNECTED", "a new singleton never claims a connection");
    assert.equal(canonical?.executionEnabled, false);
    assert.equal(canonical?.lastEvaluatedAt, null, "never evaluated is visible to callers");
  }

  // A duplicate (as a concurrent first write could create) must not change the answer.
  const [dup] = await db.insert(brokerHealthStateTable).values({ lastStatus: "CONNECTED", executionEnabled: true }).returning();
  stateIds.push(dup!.id);
  const [lowest] = await db.select({ id: brokerHealthStateTable.id }).from(brokerHealthStateTable).orderBy(asc(brokerHealthStateTable.id)).limit(1);
  assert.equal((await readBrokerHealthState())?.id, lowest!.id);
  assert.notEqual((await readBrokerHealthState())?.id, dup!.id, "a later duplicate is never read");
  const inTx = await db.transaction((tx) => readBrokerHealthState(tx));
  assert.equal(inTx?.id, lowest!.id);
});

test("health logs are newest first", async () => {
  await appendBrokerHealthLog({ brokerName: TAG, status: "DISCONNECTED" });
  await new Promise((r) => setTimeout(r, 5));
  await appendBrokerHealthLog({ brokerName: TAG, status: "DEGRADED" });
  const latest = await readLatestBrokerHealthLog();
  assert.equal(latest?.brokerName, TAG);
  assert.equal(latest?.status, "DEGRADED");
  const two = await listBrokerHealthLogs(2);
  assert.equal(two.length, 2);
  assert.ok(two[0]!.createdAt.getTime() >= two[1]!.createdAt.getTime());
});

test("read-only snapshots and logs are scoped to one owner", async () => {
  const now = Date.now();
  // id order and createdAt order deliberately disagree.
  await insertReadOnlySnapshot({ userId: a.id, snapshotId: `${TAG}-a1`, provider: TAG, mode: "READ_ONLY", connected: false });
  await db.update(brokerReadonlySnapshotsTable).set({ createdAt: new Date(now + 60_000) }).where(inArray(brokerReadonlySnapshotsTable.snapshotId, [`${TAG}-a1`]));
  await insertReadOnlySnapshot({ userId: a.id, snapshotId: `${TAG}-a2`, provider: TAG, mode: "READ_ONLY", connected: true });
  await insertReadOnlySnapshot({ userId: b.id, snapshotId: `${TAG}-b1`, provider: TAG, mode: "READ_ONLY", connected: true });
  await insertReadOnlySnapshot({ userId: null, snapshotId: `${TAG}-legacy`, provider: TAG, mode: "READ_ONLY", connected: true });
  await insertReadOnlyLog({ userId: a.id, connectorId: TAG, eventType: "SNAPSHOT_CREATED", severity: "INFO", message: "a" });
  await insertReadOnlyLog({ userId: null, connectorId: TAG, eventType: "SNAPSHOT_CREATED", severity: "INFO", message: "legacy" });

  const byId = await listOwnerReadOnlySnapshots(a.id, 10, "id");
  assert.deepEqual(byId.map((r) => r.snapshotId), [`${TAG}-a2`, `${TAG}-a1`]);
  const byCreated = await listOwnerReadOnlySnapshots(a.id, 10, "createdAt");
  assert.deepEqual(byCreated.map((r) => r.snapshotId), [`${TAG}-a1`, `${TAG}-a2`]);
  assert.deepEqual((await listOwnerReadOnlySnapshots(b.id, 10)).map((r) => r.snapshotId), [`${TAG}-b1`]);
  assert.equal((await listOwnerReadOnlySnapshots(0, 10)).length, 0, "owner 0 fails closed");

  const logs = await listOwnerReadOnlyLogs(a.id, 10, "createdAt");
  assert.deepEqual(logs.map((r) => r.message), ["a"], "legacy ownerless logs are never returned");

  const status = await readOwnerLatestReadOnlyStatus(a.id);
  assert.equal(status?.connected, true, "newest by id is what the connector reported last");
  assert.equal(status?.provider, TAG);
  assert.ok(status?.createdAt instanceof Date, "the report time travels with the status");
  assert.equal(await readOwnerLatestReadOnlyStatus(0), null, "no snapshot is null, never connected");
});

test("the shared-master pool reader returns the one row per master, null when none", async () => {
  const [m1, m2] = POOL_MASTERS as [number, number];
  assert.equal(await readMasterBridgePoolByMaster(m1), null, "no pool row is null, never a fabricated pool");
  // Same upsert shape the LIVE projection writer (lib/live/masterBridgePool.ts) uses.
  await db.insert(arxMasterBridgePoolTable).values({ masterConnectionId: m1, mt5Balance: 1000, mt5Equity: 990, snapshotStatus: "FRESH" });
  await db.insert(arxMasterBridgePoolTable).values({ masterConnectionId: m2, mt5Balance: 50, isOverAllocated: true, allocationDeficit: 25, snapshotStatus: "STALE" });
  const p1 = await readMasterBridgePoolByMaster(m1);
  assert.equal(p1?.masterConnectionId, m1);
  assert.equal(p1?.mt5Balance, 1000);
  assert.equal(p1?.snapshotStatus, "FRESH", "the stored freshness label travels with the row");
  assert.equal((await readMasterBridgePoolByMaster(m2))?.isOverAllocated, true);
  assert.equal(await anyMasterBridgePoolOverAllocated(), true, "an over-allocated row is seen by the pre-check");
});

test("Bridge v2 stream reads are user-scoped; the trace read is newest-updated first and capped", async () => {
  // Same seed shape Bridge v2 ingest writes.
  const base = Date.now();
  for (const [i, key] of ["s1", "s2", "s3"].entries()) {
    await db.insert(bridgeV2StreamStateTable).values({ userId: a.id, messageType: "HEARTBEAT", streamKey: `${TAG}-${key}`, updatedAt: new Date(base + i * 1000) });
  }
  await db.insert(bridgeV2StreamStateTable).values({ userId: b.id, messageType: "HEARTBEAT", streamKey: `${TAG}-b`, updatedAt: new Date(base + 10_000) });

  const mine = await listBridgeV2StreamStates(a.id);
  assert.deepEqual(mine.map((r) => r.streamKey).sort(), [`${TAG}-s1`, `${TAG}-s2`, `${TAG}-s3`], "another user's streams are never returned");
  const all = await listBridgeV2StreamStates(null);
  assert.ok(all.some((r) => r.userId === b.id) && all.some((r) => r.userId === a.id), "null scope reads every user (admin monitor)");
  assert.equal((await listBridgeV2StreamStates(0)).length, 0, "user 0 matches nothing");

  const recent = await listRecentBridgeV2StreamStates(a.id, 2);
  assert.deepEqual(recent.map((r) => r.streamKey), [`${TAG}-s3`, `${TAG}-s2`]);
});

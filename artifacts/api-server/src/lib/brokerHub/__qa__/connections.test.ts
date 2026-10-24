// Broker Hub connection store on a real database (Tier 1 finalization, item 1).
//
// Proves the one owner of mt5_connection:
//   - per-user reads never return another user's connection,
//   - token hashes never leave the hub (hasBridgeToken instead),
//   - the active / primary / live-bridge picks follow one rule each,
//   - bridge auth accepts the current token, the previous token only inside
//     its grace window, and nothing once the connection is revoked,
//   - operator rotation parks the old hash in SQL; revocation clears both.
//
// Run: pnpm --filter @workspace/api-server run test:broker-hub-connections

import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { inArray } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import {
  createConnection, deleteFixtureConnections, findConnectionByBridgeTokenHash, getUserActiveConnection,
  getUserConnection, getUserLiveBridge, getUserLiveSnapshotMarkerMs, getUserPrimaryConnection, listConnections,
  listUserConnections, revokeBridgeToken, rotateBridgeToken, updateUserConnection,
} from "../connections.js";

const EMAILS = ["qa+broker-hub-a@arx.test", "qa+broker-hub-b@arx.test"];
let a = 0;
let b = 0;
const created: number[] = [];
const stamp = Date.now();
const hash = (s: string) => `qa_hash_${stamp}_${s}`;

async function cleanup(): Promise<void> {
  await deleteFixtureConnections(created.splice(0));
  const ids = (await db.select({ id: usersTable.id }).from(usersTable).where(inArray(usersTable.email, EMAILS))).map((u) => u.id);
  if (ids.length) {
    await deleteFixtureConnections((await listConnections({ userIds: ids })).map((c) => c.id));
    await db.delete(usersTable).where(inArray(usersTable.id, ids));
  }
}

async function conn(userId: number, over: Parameters<typeof createConnection>[0] = {}) {
  const c = await createConnection({ userId, connectionName: "qa", status: "connected", ...over });
  created.push(c.id);
  return c;
}

before(async () => {
  await cleanup();
  const rows = await db.insert(usersTable).values(EMAILS.map((email) => ({ email, name: "QA Hub", role: "USER", isSystemUser: true })))
    .returning({ id: usersTable.id });
  a = rows[0]!.id;
  b = rows[1]!.id;
});
beforeEach(async () => { await deleteFixtureConnections(created.splice(0)); });
after(cleanup);

test("per-user reads never return another user's connection", async () => {
  const mine = await conn(a);
  const theirs = await conn(b);
  assert.deepEqual((await listUserConnections(a)).map((c) => c.id), [mine.id]);
  assert.equal(await getUserConnection(a, theirs.id), null);
  assert.equal((await getUserConnection(b, theirs.id))?.id, theirs.id);
  assert.equal(await updateUserConnection(a, theirs.id, { connectionName: "hijack" }), null, "a write to another user's row is refused");
});

test("token hashes never leave the hub; presence is a boolean", async () => {
  const c = await conn(a, { apiKeyHash: hash("x"), previousApiKeyHash: hash("old") });
  const [read] = await listUserConnections(a);
  assert.equal(read!.id, c.id);
  assert.equal("apiKeyHash" in read!, false);
  assert.equal("previousApiKeyHash" in read!, false);
  assert.equal(read!.hasBridgeToken, true);
  await revokeBridgeToken(c.id, new Date());
  assert.equal((await getUserConnection(a, c.id))!.hasBridgeToken, false);
});

test("primary = first registered; active = freshest heartbeat among non-revoked; live = non-demo", async () => {
  const now = Date.now();
  const first = await conn(a, { accountType: "demo", lastHeartbeat: new Date(now - 60_000), apiKeyHash: hash("1") });
  const fresh = await conn(a, { accountType: "demo", lastHeartbeat: new Date(now - 1_000), apiKeyHash: hash("2") });
  const live = await conn(a, { accountType: "live", lastHeartbeat: new Date(now - 30_000), apiKeyHash: hash("3"),
    lastPositionsSnapshotAt: new Date(now - 5_000) });
  const never = await conn(a, { accountType: "live", lastHeartbeat: null, apiKeyHash: hash("4") });
  assert.equal((await getUserPrimaryConnection(a))?.id, first.id);
  assert.equal((await getUserActiveConnection(a))?.id, fresh.id, "a bridge that never beat does not win");
  assert.equal((await getUserLiveBridge(a))?.id, live.id);
  assert.equal(await getUserLiveSnapshotMarkerMs(a), now - 5_000);
  await revokeBridgeToken(fresh.id, new Date());
  assert.equal((await getUserActiveConnection(a))?.id, live.id);
  assert.ok(never.id > 0);
});

test("bridge auth: current token, previous token only in grace, nothing once revoked", async () => {
  const c = await conn(a, { apiKeyHash: hash("cur") });
  assert.equal((await findConnectionByBridgeTokenHash(hash("cur")))?.via, "current");
  assert.equal(await findConnectionByBridgeTokenHash(hash("nope")), null);

  const now = new Date();
  await rotateBridgeToken(c.id, { hash: hash("new"), last4: "abcd", now, graceExpiry: new Date(now.getTime() + 60_000), adminId: null, reason: "qa rotation" });
  assert.equal((await findConnectionByBridgeTokenHash(hash("new")))?.via, "current");
  const grace = await findConnectionByBridgeTokenHash(hash("cur"));
  assert.equal(grace?.via, "previous_grace", "the old hash was parked in SQL");
  assert.equal(await findConnectionByBridgeTokenHash(hash("cur"), new Date(now.getTime() + 120_000)), null, "grace expired");

  await rotateBridgeToken(c.id, { hash: hash("newer"), last4: "efgh", now, graceExpiry: null, adminId: null, reason: "instant cutover" });
  assert.equal(await findConnectionByBridgeTokenHash(hash("new")), null, "no grace = instant cutover");

  await revokeBridgeToken(c.id, new Date());
  assert.equal(await findConnectionByBridgeTokenHash(hash("newer")), null);
});

test("operator listing filters by user, status, mode and id", async () => {
  const x = await conn(a, { mode: "LIVE", status: "ACTIVE" });
  await conn(b, { mode: "DEMO", status: "ACTIVE" });
  assert.deepEqual((await listConnections({ userIds: [a, b], modes: ["LIVE"] })).map((c) => c.id), [x.id]);
  assert.deepEqual((await listConnections({ connectionIds: [x.id] })).map((c) => c.id), [x.id]);
  assert.deepEqual(await listConnections({ userIds: [] }), []);
});

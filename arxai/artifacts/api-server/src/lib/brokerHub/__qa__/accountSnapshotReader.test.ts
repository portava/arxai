// Owner decision 16 — the account snapshot reads on a real database, with
// tenant and account isolation.
//
// Proves:
//   - a user reads only their own connection's snapshot; another user's
//     connection id gives unknown (NOT found), never their figures;
//   - a never-synced connection is unknown, not the column default 0;
//   - reconciliation uses only the user's own mt5_state row: another user's
//     row and the platform (ownerless) row are never read, even when newer;
//   - a different login on the user's own legacy row is not comparable;
//   - selection falls back to the legacy row only with identity evidence.
//
// Run: pnpm --filter @workspace/api-server run test:broker-hub-account-snapshot-db

import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { inArray } from "drizzle-orm";
import { db, mt5StateTable, usersTable } from "@workspace/db";
import { createConnection, deleteFixtureConnections, listConnections, getUserAccountConnection } from "../connections.js";
import {
  readConnectionAccountReconciliation,
  readConnectionAccountSnapshot,
  readSelectedConnectionAccountSnapshot,
} from "../accountSnapshotReader.js";

const EMAILS = ["qa+acct-snap-a@arx.test", "qa+acct-snap-b@arx.test"];
let a = 0;
let b = 0;
const conns: number[] = [];
const states: number[] = [];
const synced = new Date(Date.now() - 5_000);

async function clearRows(): Promise<void> {
  await deleteFixtureConnections(conns.splice(0));
  if (states.length) await db.delete(mt5StateTable).where(inArray(mt5StateTable.id, states.splice(0)));
}

async function cleanup(): Promise<void> {
  await clearRows();
  const ids = (await db.select({ id: usersTable.id }).from(usersTable).where(inArray(usersTable.email, EMAILS))).map((u) => u.id);
  if (ids.length) {
    await deleteFixtureConnections((await listConnections({ userIds: ids })).map((c) => c.id));
    await db.delete(mt5StateTable).where(inArray(mt5StateTable.userId, ids));
    await db.delete(usersTable).where(inArray(usersTable.id, ids));
  }
}

async function conn(userId: number, over: Parameters<typeof createConnection>[0] = {}) {
  const c = await createConnection({
    userId, connectionName: "qa-acct", status: "connected",
    accountNumber: "5012345", serverName: "QA-Demo", brokerName: "QA Broker", accountCurrency: "USD",
    accountBalance: 10_000, accountEquity: 10_250, margin: 100, freeMargin: 10_150, accountSyncedAt: synced,
    ...over,
  });
  conns.push(c.id);
  return c;
}

async function state(values: typeof mt5StateTable.$inferInsert): Promise<number> {
  const [row] = await db.insert(mt5StateTable).values(values).returning({ id: mt5StateTable.id });
  states.push(row!.id);
  return row!.id;
}

before(async () => {
  await cleanup();
  const rows = await db.insert(usersTable).values(EMAILS.map((email) => ({ email, name: "QA Acct", role: "USER", isSystemUser: true })))
    .returning({ id: usersTable.id });
  a = rows[0]!.id;
  b = rows[1]!.id;
});
beforeEach(clearRows);
after(cleanup);

test("a user reads only their own connection's snapshot", async () => {
  const mine = await conn(a);
  const theirs = await conn(b, { accountBalance: 777_777, accountEquity: 777_777 });

  const s = await readConnectionAccountSnapshot(a, mine.id);
  assert.equal(s.status, "observed");
  assert.equal(s.balance, 10_000);
  assert.equal(s.identity.connectionId, mine.id);
  assert.equal(s.identity.userId, a);
  assert.equal(s.provenance.feed, "mt5_connection");

  const cross = await readConnectionAccountSnapshot(a, theirs.id);
  assert.equal(cross.status, "unknown");
  assert.equal(cross.unknownReason, "NO_CONNECTION");
  assert.equal(cross.balance, null, "another tenant's figures never leak");
});

test("a never-synced connection is unknown, not 0", async () => {
  const c = await conn(a, { accountSyncedAt: null, accountBalance: 0, accountEquity: 0 });
  const s = await readConnectionAccountSnapshot(a, c.id);
  assert.equal(s.status, "unknown");
  assert.equal(s.unknownReason, "NEVER_SYNCED");
  assert.equal(s.balance, null);
});

test("reconciliation reads only the user's own legacy row, never another tenant's or the platform row", async () => {
  const mine = await conn(a);
  // Newer rows for another tenant and the platform with the same login/server:
  // they must never be picked up for user A.
  await state({ userId: b, account: "5012345", server: "QA-Demo", balance: 1, equity: 1, lastSyncAt: new Date(Date.now() + 60_000) });
  await state({ userId: null, account: "5012345", server: "QA-Demo", balance: 2, equity: 2, lastSyncAt: new Date(Date.now() + 120_000) });

  const none = await readConnectionAccountReconciliation(a, mine.id);
  assert.equal(none.verdict, "not_comparable");
  assert.equal(none.legacy.unknownReason, "NO_LEGACY_ROW", "no row of user A exists, so nothing is compared");

  await state({ userId: a, account: "5012345", server: "QA-Demo", currency: "USD", balance: 10_000, equity: 10_250, margin: 100, freeMargin: 10_150, lastSyncAt: synced });
  const ok = await readConnectionAccountReconciliation(a, mine.id);
  assert.equal(ok.verdict, "consistent");
  assert.equal(ok.legacy.identity.userId, a);
});

test("reconciliation reports divergence and a different account on the user's own row", async () => {
  const mine = await conn(a);
  const own = await state({ userId: a, account: "5012345", server: "QA-Demo", currency: "USD", balance: 10_000, equity: 10_000, margin: 100, freeMargin: 10_150, lastSyncAt: synced });
  const diverged = await readConnectionAccountReconciliation(a, mine.id);
  assert.equal(diverged.verdict, "diverged");
  assert.equal(diverged.diffs.find((d) => d.field === "equity")?.delta, -250);

  await db.delete(mt5StateTable).where(inArray(mt5StateTable.id, [own]));
  await state({ userId: a, account: "8888888", server: "QA-Demo", balance: 5, equity: 5, lastSyncAt: synced });
  const other = await readConnectionAccountReconciliation(a, mine.id);
  assert.equal(other.verdict, "not_comparable");
  assert.equal(other.identity, "different_account");
});

test("another user's connection id gives an unknown reconciliation", async () => {
  const theirs = await conn(b);
  await state({ userId: a, account: "5012345", server: "QA-Demo", balance: 10_000, equity: 10_250, lastSyncAt: synced });
  const r = await readConnectionAccountReconciliation(a, theirs.id);
  assert.equal(r.verdict, "not_comparable");
  assert.equal(r.authoritative.unknownReason, "NO_CONNECTION");
});

test("selection falls back to the user's legacy row only with identity evidence", async () => {
  const c = await conn(a, { accountSyncedAt: null });
  await state({ userId: null, account: "5012345", server: "QA-Demo", balance: 999_999, equity: 999_999, lastSyncAt: new Date() });
  const platformOnly = await readSelectedConnectionAccountSnapshot(a, c.id);
  assert.equal(platformOnly.status, "unknown", "the platform row is never read for a trader");

  await state({ userId: a, account: "5012345", server: "QA-Demo", balance: 4_000, equity: 4_100, lastSyncAt: synced });
  const matched = await readSelectedConnectionAccountSnapshot(a, c.id);
  assert.equal(matched.status, "observed");
  assert.equal(matched.provenance.feed, "mt5_state");
  assert.equal(matched.provenance.authoritative, false);
  assert.equal(matched.balance, 4_000);
});


test("account summary selection is user-scoped, newest synced and never revoked; advice cannot use platform balance", async () => {
  await conn(a, { accountSyncedAt: new Date(Date.now() - 30_000), accountBalance: 1_000 });
  const newest = await conn(a, { accountSyncedAt: new Date(), accountBalance: 2_000, lastHeartbeat: new Date() });
  await conn(a, { accountSyncedAt: new Date(Date.now() + 1_000), accountBalance: 999_999, status: "revoked" });
  await conn(b, { accountSyncedAt: new Date(), accountBalance: 8_000 });
  await state({ userId: null, balance: 9_999_999, equity: 9_999_999, lastHeartbeatAt: new Date() });
  assert.equal((await getUserAccountConnection(a))?.id, newest.id);
  const { loadPaperIntelligenceSnapshot } = await import("../../paperIntelligence.js");
  assert.equal((await loadPaperIntelligenceSnapshot(a)).balance, 2_000);
  assert.equal((await loadPaperIntelligenceSnapshot(b)).balance, 8_000);
  const missing = await loadPaperIntelligenceSnapshot(-999999);
  assert.equal(missing.balance, null);
  assert.equal(missing.isFresh, false);
});

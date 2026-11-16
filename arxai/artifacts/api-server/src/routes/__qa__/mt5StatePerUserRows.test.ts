// mt5_state is one row per bridge user (audit H6 follow-up, owner decision
// 2026-11-04). On a real database: the first user adopts the legacy unowned
// row, a second user gets their own row (so their EA never overwrites the
// first user's account), each user's read is their own row, and the platform
// read is the most recently heartbeating EA.
//
// Run (integration lane, needs DATABASE_URL):
//   node --import tsx --test --test-force-exit src/routes/__qa__/mt5StatePerUserRows.test.ts

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { eq, inArray, isNull, or } from "drizzle-orm";
import { db, usersTable, mt5StateTable } from "@workspace/db";
import { loadOrCreateState } from "../mt5.js";
import { readLatestUserMt5State, readPlatformMt5State } from "../../lib/brokerHub/mt5StateReader.js";

const EMAILS = ["qa+mt5rows-a@arx.test", "qa+mt5rows-b@arx.test"];
let a = 0; let b = 0;
let parked: Array<typeof mt5StateTable.$inferSelect> = [];

before(async () => {
  // Park any pre-existing rows (owned or legacy) so the table starts empty, then restore them.
  parked = await db.select().from(mt5StateTable);
  await db.delete(mt5StateTable);
  await db.delete(usersTable).where(inArray(usersTable.email, EMAILS));
  const rows = await db.insert(usersTable).values(EMAILS.map((email, i) => ({ email, name: `QA Rows ${i}`, role: "USER", isSystemUser: true }))).returning({ id: usersTable.id });
  a = rows[0]!.id; b = rows[1]!.id;
});
after(async () => {
  await db.delete(mt5StateTable);
  if (parked.length) await db.insert(mt5StateTable).values(parked.map(({ id: _id, ...rest }) => rest));
  await db.delete(usersTable).where(inArray(usersTable.email, EMAILS));
});

test("the first user adopts the legacy unowned row; the second gets their own; neither overwrites the other", async () => {
  const [legacy] = await db.insert(mt5StateTable).values({ account: "legacy-1", balance: 100 }).returning();
  const rowA = await loadOrCreateState(a);
  assert.equal(rowA.id, legacy!.id, "user A adopts the legacy row");
  assert.equal(rowA.userId, a);

  const rowB = await loadOrCreateState(b);
  assert.notEqual(rowB.id, rowA.id, "user B gets a row of their own");
  assert.equal(rowB.userId, b);

  await db.update(mt5StateTable).set({ account: "acct-A", balance: 1_000, lastHeartbeatAt: new Date(Date.now() - 60_000) }).where(eq(mt5StateTable.id, rowA.id));
  await db.update(mt5StateTable).set({ account: "acct-B", balance: 2_000, lastHeartbeatAt: new Date() }).where(eq(mt5StateTable.id, rowB.id));

  assert.equal((await readLatestUserMt5State(a))?.account, "acct-A");
  assert.equal((await readLatestUserMt5State(b))?.account, "acct-B");
  assert.equal((await loadOrCreateState(a)).id, rowA.id, "a later write from user A lands in user A's row");
  assert.equal((await loadOrCreateState(b)).id, rowB.id);
  assert.equal((await db.select().from(mt5StateTable).where(or(eq(mt5StateTable.userId, a), eq(mt5StateTable.userId, b), isNull(mt5StateTable.userId)))).length, 2);
});

test("the platform read is the EA that heartbeated most recently", async () => {
  const platform = await readPlatformMt5State();
  assert.equal(platform?.account, "acct-B", "B heartbeated last");
  await db.update(mt5StateTable).set({ lastHeartbeatAt: new Date(Date.now() + 1_000) }).where(eq(mt5StateTable.userId, a));
  assert.equal((await readPlatformMt5State())?.account, "acct-A");
  const inTx = await db.transaction((tx) => readPlatformMt5State(tx));
  assert.equal(inTx?.account, "acct-A");
});

test("a write with no bridge user lands in the platform row, never in a user's row by guess", async () => {
  const row = await loadOrCreateState(null);
  assert.equal(row.account, "acct-A", "the freshest EA's row is the platform row");
});

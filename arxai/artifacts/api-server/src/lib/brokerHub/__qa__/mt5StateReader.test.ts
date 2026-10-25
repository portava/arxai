// Broker Hub mt5_state reader — ownership and ordering, on a real database.
//
// Proves:
//   - a user's read returns that user's latest synced snapshot and never
//     another user's row or a legacy (ownerless) row,
//   - a scoped read admits legacy rows only when the scope does (operator),
//     never for a trader,
//   - the platform read is the lowest-id row, deterministically, and works
//     inside a transaction.
//
// Run: pnpm --filter @workspace/api-server run test:broker-hub-mt5-state

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { asc, inArray } from "drizzle-orm";
import { db, mt5StateTable, usersTable, type User } from "@workspace/db";
import { readLatestUserMt5State, readPlatformMt5State, readScopedMt5State } from "../mt5StateReader.js";
import { ownerScope } from "../../auth/ownerScope.js";

const EMAILS = ["qa+mt5-state-a@arx.test", "qa+mt5-state-b@arx.test"];
let a: User;
let b: User;
const rowIds: number[] = [];

async function cleanup(): Promise<void> {
  if (rowIds.length) await db.delete(mt5StateTable).where(inArray(mt5StateTable.id, rowIds));
  await db.delete(usersTable).where(inArray(usersTable.email, EMAILS));
}

async function insertState(values: typeof mt5StateTable.$inferInsert): Promise<number> {
  const [row] = await db.insert(mt5StateTable).values(values).returning({ id: mt5StateTable.id });
  rowIds.push(row!.id);
  return row!.id;
}

before(async () => {
  await cleanup();
  [a, b] = await db.insert(usersTable).values(EMAILS.map((email, i) => ({
    email, name: `QA mt5 state ${i}`, role: "USER", isSystemUser: true,
  }))).returning() as [User, User];
});
after(cleanup);

test("a user's read is their latest synced snapshot only", async () => {
  await insertState({ userId: a.id, equity: 100, lastSyncAt: new Date(Date.now() - 60_000) });
  const latest = await insertState({ userId: a.id, equity: 200, lastSyncAt: new Date() });
  await insertState({ userId: a.id, equity: 300, lastSyncAt: null });
  await insertState({ userId: b.id, equity: 999, lastSyncAt: new Date(Date.now() + 60_000) });
  await insertState({ userId: null, equity: 555, lastSyncAt: new Date(Date.now() + 120_000) });

  const row = await readLatestUserMt5State(a.id);
  assert.equal(row?.id, latest, "newest lastSyncAt wins; never-synced rows sort last");
  assert.equal(row?.userId, a.id);
  const nobody = await readLatestUserMt5State(-1);
  assert.equal(nobody, null);
});

test("a scoped read admits legacy rows for an operator, never for a trader", async () => {
  const trader = await readScopedMt5State((col) => ownerScope(col, b));
  assert.equal(trader?.userId, b.id, "trader sees only their own row");
  const operator = await readScopedMt5State((col) => ownerScope(col, { ...b, role: "OWNER" } as User));
  assert.ok(operator && (operator.userId === b.id || operator.userId === null), "operator scope may include legacy rows");
  const stranger = await readScopedMt5State((col) => ownerScope(col, { ...a, id: -1 } as User));
  assert.equal(stranger, null, "a user with no rows sees nothing, legacy rows included");
});

test("the platform read is the lowest-id row, also inside a transaction", async () => {
  const [first] = await db.select({ id: mt5StateTable.id }).from(mt5StateTable).orderBy(asc(mt5StateTable.id)).limit(1);
  assert.equal((await readPlatformMt5State())?.id, first!.id);
  const inTx = await db.transaction((tx) => readPlatformMt5State(tx));
  assert.equal(inTx?.id, first!.id);
});

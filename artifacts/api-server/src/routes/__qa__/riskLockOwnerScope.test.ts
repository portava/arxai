// Risk locks are owner-scoped (audit H3, PR #105): on a real database with the
// real permission router mounted.
//
// Proves:
//   - GET /risk-locks and POST /risk-locks require a signed-in user (401 and
//     nothing stored otherwise);
//   - a trader sees, and is held by, only their own locks plus legacy ownerless
//     ones — never another trader's (the paper permission verdict, the
//     /risk-locks list and the duplicate guard all read the same scope, the
//     rule trading readiness and the live pipeline already use);
//   - a lock created through POST /risk-locks is owned by its creator, so it
//     never holds anyone else.
//
// Run: pnpm --filter @workspace/api-server run test:audit-gaps-r2-20261103

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { eq, gt, inArray } from "drizzle-orm";
import { db, riskLocksTable, usersTable, userRiskSettingsTable } from "@workspace/db";
import permissionRouter, { gatherInputsAndEvaluate } from "../permission.js";

const EMAIL_A = "qa+risk-lock-scope-a@arx.test";
const EMAIL_B = "qa+risk-lock-scope-b@arx.test";
const TAG = `qa-risk-lock-scope-${process.pid}`;
let userA = 0;
let userB = 0;
let server: Server;
let base = "";
let maxLockBefore = 0;

before(async () => {
  maxLockBefore = (await db.select({ id: riskLocksTable.id }).from(riskLocksTable)).reduce((m, r) => Math.max(m, r.id), 0);
  await db.delete(usersTable).where(inArray(usersTable.email, [EMAIL_A, EMAIL_B]));
  const [a] = await db.insert(usersTable).values({ email: EMAIL_A, name: "QA risk lock A", role: "USER" }).returning({ id: usersTable.id });
  const [b] = await db.insert(usersTable).values({ email: EMAIL_B, name: "QA risk lock B", role: "USER" }).returning({ id: usersTable.id });
  userA = a!.id;
  userB = b!.id;

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    // x-qa-user names the signed-in trader; absent = anonymous.
    const who = req.header("x-qa-user");
    if (who) (req as unknown as { authUser: unknown }).authUser = { id: Number(who), role: "USER" };
    (req as unknown as { log: unknown }).log = { error: () => {}, warn: () => {}, info: () => {} };
    next();
  });
  app.use("/api", permissionRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  // The RISK_LOCK_CREATED vault events stay: the vault is append-only.
  await db.delete(riskLocksTable).where(gt(riskLocksTable.id, maxLockBefore));
  await db.delete(userRiskSettingsTable).where(inArray(userRiskSettingsTable.userId, [userA, userB]));
  await db.delete(usersTable).where(inArray(usersTable.id, [userA, userB]));
});

async function call(method: "GET" | "POST", path: string, user: number | null, body?: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (user != null) headers["x-qa-user"] = String(user);
  const r = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as Record<string, any> };
}
const reasons = (locks: Array<{ reason: string }>) => locks.map((l) => l.reason).filter((r) => r.startsWith(TAG)).sort();

test("risk locks are read per user: own plus ownerless, never another trader's", async () => {
  const end = new Date(Date.now() + 3_600_000);
  await db.insert(riskLocksTable).values([
    { userId: userA, lockType: "USER_MANUAL", reason: `${TAG} A own`, endTime: end },
    { userId: userB, lockType: "COOLDOWN_1H", reason: `${TAG} B own`, endTime: end },
    { userId: null, lockType: "DAILY_LOSS_LIMIT", reason: `${TAG} ownerless`, endTime: end },
  ]);

  const listA = await call("GET", "/risk-locks", userA);
  assert.equal(listA.status, 200);
  assert.deepEqual(reasons(listA.body.locks), [`${TAG} A own`, `${TAG} ownerless`]);
  const listB = await call("GET", "/risk-locks", userB);
  assert.deepEqual(reasons(listB.body.locks), [`${TAG} B own`, `${TAG} ownerless`]);

  const verdictA = (await gatherInputsAndEvaluate(userA)).verdict;
  assert.deepEqual(reasons(verdictA.activeLocks), [`${TAG} A own`, `${TAG} ownerless`], "B's lock never holds A's paper verdict");
  const verdictB = (await gatherInputsAndEvaluate(userB)).verdict;
  assert.deepEqual(reasons(verdictB.activeLocks), [`${TAG} B own`, `${TAG} ownerless`]);
});

test("GET and POST /risk-locks require a signed-in user; anonymous calls store nothing", async () => {
  assert.equal((await call("GET", "/risk-locks", null)).status, 401);
  const before = await db.select({ id: riskLocksTable.id }).from(riskLocksTable).where(gt(riskLocksTable.id, maxLockBefore));
  const anon = await call("POST", "/risk-locks", null, { lockType: "USER_MANUAL", reason: `${TAG} anonymous` });
  assert.equal(anon.status, 401);
  const afterRows = await db.select({ id: riskLocksTable.id }).from(riskLocksTable).where(gt(riskLocksTable.id, maxLockBefore));
  assert.equal(afterRows.length, before.length, "no lock was created anonymously");
});

test("a lock created through POST /risk-locks is owned by its creator and holds no one else", async () => {
  // B already holds a COOLDOWN_1H lock: A's request is not answered with B's
  // lock as a "duplicate" — A gets a lock of their own.
  const created = await call("POST", "/risk-locks", userA, { lockType: "COOLDOWN_1H", reason: `${TAG} A cooldown` });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.reason, `${TAG} A cooldown`, "not B's lock returned as a duplicate");
  const [row] = await db.select().from(riskLocksTable).where(eq(riskLocksTable.id, created.body.id));
  assert.equal(row!.userId, userA, "the new lock is owned by its creator");

  const again = await call("POST", "/risk-locks", userA, { lockType: "COOLDOWN_1H", reason: `${TAG} A cooldown twice` });
  assert.equal(again.body.id, created.body.id, "A's own active lock of that type is the duplicate");

  const verdictB = (await gatherInputsAndEvaluate(userB)).verdict;
  assert.ok(!reasons(verdictB.activeLocks).includes(`${TAG} A cooldown`), "A's new lock never holds B");
  const listB = await call("GET", "/risk-locks", userB);
  assert.ok(!reasons(listB.body.locks).includes(`${TAG} A cooldown`));
});

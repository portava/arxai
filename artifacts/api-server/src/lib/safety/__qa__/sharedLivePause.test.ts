// The shared-live pause authority (owner decision 19, Tier 1 Platform Safety
// round 5), on a real database.
//
// Proves:
//   - pauseSharedLive() pauses ONE pool row: the other pool row, every
//     global_trading_settings row, the safety_core row and the install-wide
//     stop answer (platformStop()) are unchanged;
//   - pausing records reason / time / actor and writes one audit row
//     (SHARED_LIVE_PAUSED_OVER_ALLOCATION, naming the pool) in the same call;
//   - resumeSharedLive() clears only its own pool row (a second pool paused on
//     its own stays paused) and writes SHARED_LIVE_RESUMED;
//   - sharedLivePauseOf() (the one reader) follows the row it is given;
//   - a non-operator actor, a blank pause reason or an unknown pool is refused
//     and nothing is written (no flag change, no audit row);
//   - the admin routes keep refusing a non-operator session (403) before any
//     pool is read.
//
// The two pool rows use master connection ids no real master has and are
// removed afterwards, with this test's audit rows.
//
// Run: pnpm --filter @workspace/api-server run test:shared-live-pause

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  adminActionAuditLogTable,
  arxMasterBridgePoolTable,
  db,
  globalTradingSettingsTable,
  safetyCoreTable,
  usersTable,
} from "@workspace/db";
import { pauseSharedLive, resumeSharedLive, sharedLivePauseOf } from "../sharedLivePause.js";
import { platformStop } from "../platformSwitches.js";
import adminAllocationsRouter from "../../../routes/adminAllocations.js";

const EMAIL = "qa+shared-live-pause@arx.test";
const MASTER_A = 990_001_901;
const MASTER_B = 990_001_902;
let adminId = 0;
let poolA = 0;
let poolB = 0;
let server: Server;
let base = "";
let sessionRole = "USER";

before(async () => {
  await db.delete(arxMasterBridgePoolTable).where(inArray(arxMasterBridgePoolTable.masterConnectionId, [MASTER_A, MASTER_B]));
  await db.delete(usersTable).where(inArray(usersTable.email, [EMAIL]));
  const [u] = await db.insert(usersTable).values({ email: EMAIL, name: "QA shared-live pause", role: "ADMIN", isSystemUser: true }).returning({ id: usersTable.id });
  adminId = u!.id;
  const [a] = await db.insert(arxMasterBridgePoolTable).values({ masterConnectionId: MASTER_A }).returning();
  const [b] = await db.insert(arxMasterBridgePoolTable).values({ masterConnectionId: MASTER_B }).returning();
  poolA = a!.id;
  poolB = b!.id;

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { authUser: unknown }).authUser = { id: adminId, role: sessionRole, email: EMAIL };
    (req as unknown as { log: unknown }).log = { error: () => {}, warn: () => {}, info: () => {} };
    next();
  });
  app.use("/api", adminAllocationsRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.delete(arxMasterBridgePoolTable).where(inArray(arxMasterBridgePoolTable.id, [poolA, poolB]));
  await db.delete(adminActionAuditLogTable).where(eq(adminActionAuditLogTable.adminId, adminId));
  await db.delete(usersTable).where(eq(usersTable.id, adminId));
});

const pool = async (id: number) => (await db.select().from(arxMasterBridgePoolTable).where(eq(arxMasterBridgePoolTable.id, id)))[0]!;
const audits = (action: string) => db.select().from(adminActionAuditLogTable)
  .where(and(eq(adminActionAuditLogTable.adminId, adminId), eq(adminActionAuditLogTable.action, action)))
  .orderBy(asc(adminActionAuditLogTable.id));
const installWide = async () => ({
  gts: JSON.stringify(await db.select().from(globalTradingSettingsTable).orderBy(asc(globalTradingSettingsTable.id))),
  core: JSON.stringify(await db.select().from(safetyCoreTable).orderBy(asc(safetyCoreTable.id))),
  stop: JSON.stringify(await platformStop()),
});
const admin = { userId: 0, role: "ADMIN" };

test("pause is scoped to one pool row and never install-wide", async () => {
  admin.userId = adminId;
  const wideBefore = await installWide();
  const bBefore = await pool(poolB);

  const r = await pauseSharedLive({ scope: { poolId: poolA }, reason: "qa reconcile A", actor: admin, ipAddress: "127.0.0.1" });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.before.paused, false);
  assert.equal(r.pool.id, poolA);

  const a = await pool(poolA);
  const pa = sharedLivePauseOf(a);
  assert.equal(pa.paused, true);
  assert.equal(pa.reason, "qa reconcile A");
  assert.equal(pa.pausedByUserId, adminId);
  assert.ok(pa.pausedAt instanceof Date);
  assert.deepEqual(pa.scope, { poolId: poolA });

  assert.deepEqual(await pool(poolB), bBefore, "the other pool row is untouched");
  assert.equal(sharedLivePauseOf(await pool(poolB)).paused, false);
  assert.deepEqual(await installWide(), wideBefore, "settings rows, safety core and the install-wide stop answer are unchanged");

  const rows = await audits("SHARED_LIVE_PAUSED_OVER_ALLOCATION");
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0]!.beforeState, { sharedLivePaused: false });
  assert.deepEqual(rows[0]!.afterState, { sharedLivePaused: true, pausedReason: "qa reconcile A", poolId: poolA });
  assert.equal(rows[0]!.reason, "qa reconcile A");
  assert.equal(rows[0]!.adminRole, "ADMIN");
  assert.equal(rows[0]!.ipAddress, "127.0.0.1");
});

test("resume clears only its own pool; another pool paused on its own stays paused", async () => {
  const pb = await pauseSharedLive({ scope: { poolId: poolB }, reason: "qa reconcile B", actor: { userId: adminId, role: "OWNER" } });
  assert.equal(pb.ok, true);
  const wideBefore = await installWide();

  const r = await resumeSharedLive({ scope: { poolId: poolA }, actor: admin });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.before.paused, true);
  assert.equal(r.before.reason, "qa reconcile A");

  const a = await pool(poolA);
  assert.equal(sharedLivePauseOf(a).paused, false);
  assert.equal(a.pausedReason, null);
  assert.equal(a.pausedAt, null);
  assert.equal(a.pausedByUserId, null);
  const b = sharedLivePauseOf(await pool(poolB));
  assert.equal(b.paused, true, "pool B is still paused");
  assert.equal(b.reason, "qa reconcile B");
  assert.deepEqual(await installWide(), wideBefore, "resume never arms or releases anything install-wide");

  const rows = await audits("SHARED_LIVE_RESUMED");
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0]!.beforeState, { sharedLivePaused: true, pausedReason: "qa reconcile A" });
  assert.deepEqual(rows[0]!.afterState, { sharedLivePaused: false, poolId: poolA });

  assert.equal((await resumeSharedLive({ scope: { poolId: poolB }, actor: admin })).ok, true);
  assert.equal(sharedLivePauseOf(await pool(poolB)).paused, false);
});

test("refusals write nothing: non-operator, blank reason, unknown pool", async () => {
  const before = { a: await pool(poolA), pauses: (await audits("SHARED_LIVE_PAUSED_OVER_ALLOCATION")).length, resumes: (await audits("SHARED_LIVE_RESUMED")).length };

  for (const role of ["USER", "INVESTOR", "", null]) {
    const p = await pauseSharedLive({ scope: { poolId: poolA }, reason: "qa", actor: { userId: adminId, role } });
    assert.equal(p.ok, false);
    if (!p.ok) assert.equal(p.code, "NOT_AUTHORIZED", `pause as ${String(role)}`);
    const q = await resumeSharedLive({ scope: { poolId: poolA }, actor: { userId: adminId, role } });
    if (!q.ok) assert.equal(q.code, "NOT_AUTHORIZED", `resume as ${String(role)}`);
    else assert.fail("resume by a non-operator must be refused");
  }
  const blank = await pauseSharedLive({ scope: { poolId: poolA }, reason: "   ", actor: admin });
  assert.equal(blank.ok ? null : blank.code, "REASON_REQUIRED");
  const missing = await pauseSharedLive({ scope: { poolId: 2_000_000_000 }, reason: "qa", actor: admin });
  assert.equal(missing.ok ? null : missing.code, "POOL_NOT_FOUND");

  assert.deepEqual(await pool(poolA), before.a, "the pool row is unchanged");
  assert.equal((await audits("SHARED_LIVE_PAUSED_OVER_ALLOCATION")).length, before.pauses, "no audit row for a refused pause");
  assert.equal((await audits("SHARED_LIVE_RESUMED")).length, before.resumes, "no audit row for a refused resume");
});

test("admin routes: a non-operator session is refused before any pool is read", async () => {
  sessionRole = "USER";
  for (const path of ["/admin/shared-live/pause", "/admin/shared-live/resume"]) {
    const r = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: "qa" }) });
    assert.equal(r.status, 403, path);
    assert.equal(((await r.json()) as { error: string }).error, "ADMIN_REQUIRED");
  }
  assert.equal(sharedLivePauseOf(await pool(poolA)).paused, false);
});

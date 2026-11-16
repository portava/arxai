// The one explicit, authorized, audited stop release (owner decision 1,
// Tier 1 Platform Safety round 5), on a real database.
//
// Proves:
//   - releasePlatformStop({ stop: "platform_emergency_stop" }) clears EVERY
//     settings row (flag, engaged-at, reason) after an engage on duplicate
//     rows, records the actor, and writes one audit row that keeps the reason
//     and time the stop had;
//   - it never touches the other stop (the safety-core kill switch stays
//     engaged) and never arms anything (live arm, platform mode, venue
//     enables unchanged);
//   - releasing the safety-core kill switch goes through its owner
//     (acknowledgement still required), leaves the emergency stop engaged and
//     is audited;
//   - a non-operator actor or a missing reason is refused and nothing is
//     written (no release, no audit row);
//   - routes: POST /admin/trading/reset-kill uses it (every row); live
//     activation (POST /admin/live-shared/activate-step) with a stop engaged
//     and releaseKillSwitch refuses with an actionable message and does not
//     release; POST /system/kill-switch/reset releases only the safety core.
//
// The original settings and safety_core rows are restored afterwards.
//
// Run: pnpm --filter @workspace/api-server run test:platform-stop-release

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { and, asc, eq, gte, inArray } from "drizzle-orm";
import { adminActionAuditLogTable, db, globalTradingSettingsTable, safetyCoreTable, usersTable } from "@workspace/db";
import { engagePlatformStop, releasePlatformStop, RELEASE_AUDIT_ACTION } from "../platformStopWriter.js";
import { platformStop } from "../platformSwitches.js";
import adminTradingRouter from "../../../routes/adminTrading.js";
import adminLiveSharedReadinessRouter, { ACTIVATION_DOES_NOT_RELEASE_STOP } from "../../../routes/adminLiveSharedReadiness.js";
import systemRouter from "../../../routes/system.js";

type Row = typeof globalTradingSettingsTable.$inferSelect;
type CoreRow = typeof safetyCoreTable.$inferSelect;
const EMAIL = "qa+platform-stop-release@arx.test";
let saved: Row[] = [];
let savedCore: CoreRow[] = [];
let adminId = 0;
let server: Server;
let base = "";
let sessionRole = "ADMIN";
const startedAt = new Date();

before(async () => {
  saved = await db.select().from(globalTradingSettingsTable).orderBy(asc(globalTradingSettingsTable.id));
  savedCore = await db.select().from(safetyCoreTable).orderBy(asc(safetyCoreTable.id));
  await db.delete(usersTable).where(inArray(usersTable.email, [EMAIL]));
  const [u] = await db.insert(usersTable).values({ email: EMAIL, name: "QA stop release", role: "ADMIN", isSystemUser: true }).returning({ id: usersTable.id });
  adminId = u!.id;
  if (!savedCore.length) await db.insert(safetyCoreTable).values({});

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { authUser: unknown }).authUser = { id: adminId, role: sessionRole, email: EMAIL };
    next();
  });
  app.use("/api", adminTradingRouter, adminLiveSharedReadinessRouter, systemRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.delete(globalTradingSettingsTable);
  if (saved.length) await db.insert(globalTradingSettingsTable).values(saved);
  await db.delete(safetyCoreTable);
  if (savedCore.length) await db.insert(safetyCoreTable).values(savedCore);
  await db.delete(adminActionAuditLogTable).where(eq(adminActionAuditLogTable.adminId, adminId));
  await db.delete(usersTable).where(eq(usersTable.id, adminId));
});

const rows = () => db.select().from(globalTradingSettingsTable).orderBy(asc(globalTradingSettingsTable.id));
const twoRows = async (patch: Partial<typeof globalTradingSettingsTable.$inferInsert> = {}) => {
  await db.delete(globalTradingSettingsTable);
  await db.insert(globalTradingSettingsTable).values([patch, patch]);
};
const setCore = async (engaged: boolean) => {
  await db.update(safetyCoreTable).set({ killSwitchEngaged: engaged, killSwitchReason: engaged ? "qa core" : null, killSwitchEngagedAt: engaged ? new Date() : null });
};
const audits = (action: string) => db.select().from(adminActionAuditLogTable)
  .where(and(eq(adminActionAuditLogTable.adminId, adminId), eq(adminActionAuditLogTable.action, action), gte(adminActionAuditLogTable.createdAt, startedAt)))
  .orderBy(asc(adminActionAuditLogTable.id));
const post = async (path: string, body: unknown) => {
  const r = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() as Record<string, unknown> };
};

test("duplicate settings rows: engage then release clears EVERY row, records the actor, audits with the old reason", async () => {
  await twoRows({ platformMode: "LIVE", liveEnabled: true, demoEnabled: true, liveBrokerExecutionArmed: true });
  await setCore(false);
  const engaged = await engagePlatformStop({ reason: "qa incident", actorUserId: adminId, source: "admin_trading_emergency_kill" });
  const auditBefore = (await audits(RELEASE_AUDIT_ACTION.platform_emergency_stop)).length;

  const res = await releasePlatformStop({
    stop: "platform_emergency_stop", reason: "qa all clear", actor: { userId: adminId, role: "OWNER" }, source: "admin_trading_reset_kill",
  });
  assert.equal(res.ok, true);
  assert.ok(res.ok && res.wasEngaged, "it was engaged");
  for (const r of await rows()) {
    assert.equal(r.emergencyKillSwitch, false, `row ${r.id} released`);
    assert.equal(r.killSwitchReason, null, `row ${r.id} reason cleared`);
    assert.equal(r.killSwitchEngagedAt, null, `row ${r.id} engaged-at cleared`);
    assert.equal(r.updatedByAdminId, adminId, "actor recorded");
    // Never arms or opens anything.
    assert.equal(r.liveBrokerExecutionArmed, true, "the live arm is unchanged");
    assert.equal(r.platformMode, "LIVE");
    assert.equal(r.liveEnabled, true);
  }
  assert.equal((await platformStop()).engaged, false);

  const a = await audits(RELEASE_AUDIT_ACTION.platform_emergency_stop);
  assert.equal(a.length, auditBefore + 1, "one audit row");
  const row = a.at(-1)!;
  assert.equal(row.reason, "qa all clear");
  assert.equal(row.adminRole, "OWNER");
  const bs = row.beforeState as Record<string, unknown>;
  assert.equal(bs.engaged, true);
  assert.equal(bs.reason, "qa incident", "the audit keeps the reason the stop had");
  assert.equal(bs.engagedAt, engaged.engagedAt.toISOString(), "and its engage time");
  assert.equal((row.afterState as Record<string, unknown>).rowCount, 2);
});

test("releasing one stop never touches the other", async () => {
  await twoRows({ liveBrokerExecutionArmed: false });
  await engagePlatformStop({ reason: "qa both", actorUserId: adminId, source: "admin_trading_emergency_kill" });
  await setCore(true);

  const r1 = await releasePlatformStop({ stop: "platform_emergency_stop", reason: "qa emergency only", actor: { userId: adminId, role: "ADMIN" }, source: "admin_trading_reset_kill" });
  assert.equal(r1.ok, true);
  let stop = await platformStop();
  assert.deepEqual(stop.sources, ["safety_core_kill_switch"], "the safety-core kill switch stays engaged");
  const armed = (await rows()).map((r) => r.liveBrokerExecutionArmed);
  assert.deepEqual(armed, [false, false], "release does not arm");

  await engagePlatformStop({ reason: "qa again", actorUserId: adminId, source: "admin_trading_emergency_kill" });
  // The safety core keeps its acknowledgement.
  const refused = await releasePlatformStop({ stop: "safety_core_kill_switch", reason: "qa core release", actor: { userId: adminId, role: "ADMIN" }, source: "system_kill_switch_reset", acknowledgement: "nope" });
  assert.equal(refused.ok, false);
  assert.equal(!refused.ok && refused.code, "SAFETY_CORE_REFUSED");
  assert.deepEqual((await platformStop()).sources, ["platform_emergency_stop", "safety_core_kill_switch"], "a refused reset writes nothing");

  const auditBefore = (await audits(RELEASE_AUDIT_ACTION.safety_core_kill_switch)).length;
  const r2 = await releasePlatformStop({ stop: "safety_core_kill_switch", reason: "qa core release", actor: { userId: adminId, role: "ADMIN" }, source: "system_kill_switch_reset", acknowledgement: "I_UNDERSTAND_RISK" });
  assert.equal(r2.ok, true);
  stop = await platformStop();
  assert.deepEqual(stop.sources, ["platform_emergency_stop"], "the emergency stop stays engaged");
  for (const r of await rows()) assert.equal(r.killSwitchReason, "qa again", "settings rows untouched");
  const core = (await db.select().from(safetyCoreTable).orderBy(asc(safetyCoreTable.id)))[0]!;
  assert.equal(core.operationalMode, "OBSERVE_ONLY", "the safety core comes back observe-only (never re-armed)");
  assert.equal((await audits(RELEASE_AUDIT_ACTION.safety_core_kill_switch)).length, auditBefore + 1, "audited");
});

test("authorization and reason: refused, nothing written", async () => {
  await twoRows();
  await engagePlatformStop({ reason: "qa auth", actorUserId: adminId, source: "admin_trading_emergency_kill" });
  const before = (await audits(RELEASE_AUDIT_ACTION.platform_emergency_stop)).length;
  for (const role of ["USER", "INVESTOR", "", null]) {
    const r = await releasePlatformStop({ stop: "platform_emergency_stop", reason: "qa not allowed", actor: { userId: adminId, role }, source: "admin_trading_reset_kill" });
    assert.equal(!r.ok && r.code, "NOT_AUTHORIZED", String(role));
  }
  const short = await releasePlatformStop({ stop: "platform_emergency_stop", reason: " x ", actor: { userId: adminId, role: "ADMIN" }, source: "admin_trading_reset_kill" });
  assert.equal(!short.ok && short.code, "REASON_REQUIRED");
  for (const r of await rows()) assert.equal(r.emergencyKillSwitch, true, "still engaged on every row");
  assert.equal((await audits(RELEASE_AUDIT_ACTION.platform_emergency_stop)).length, before, "no audit row");

  await db.delete(globalTradingSettingsTable);
  const none = await releasePlatformStop({ stop: "platform_emergency_stop", reason: "qa none", actor: { userId: adminId, role: "ADMIN" }, source: "admin_trading_reset_kill" });
  assert.equal(!none.ok && none.code, "NO_SETTINGS_ROW");
  assert.equal((await audits(RELEASE_AUDIT_ACTION.platform_emergency_stop)).length, before, "no audit row without a row to release");
});

test("routes: reset-kill releases every row; activation refuses to release; system reset releases only the safety core", async () => {
  await twoRows({
    platformMode: "DEMO", accountRoutingMode: "SHARED_MASTER_MT5", sharedLiveTradingEnabled: true,
    masterBridgeLiveEnabled: true, platformMasterBridgeConnectionId: 1,
  });
  await setCore(false);
  await engagePlatformStop({ reason: "qa route", actorUserId: adminId, source: "admin_trading_emergency_kill" });

  // Live activation never releases the stop: refused with an actionable message, nothing written.
  const auditsBefore = (await audits("ADMIN_ACTIVATED_LIVE_SHARED_STEP")).length;
  const act = await post("/admin/live-shared/activate-step", { confirm: true, releaseKillSwitch: true, platformMode: "LIVE", liveEnabled: true });
  assert.equal(act.status, 409);
  assert.equal(act.body.error, ACTIVATION_DOES_NOT_RELEASE_STOP);
  assert.match(String(act.body.detail), /POST \/api\/admin\/trading\/reset-kill/);
  for (const r of await rows()) {
    assert.equal(r.emergencyKillSwitch, true, "activation did not release");
    assert.equal(r.killSwitchReason, "qa route");
    assert.equal(r.platformMode, "DEMO", "the refused activation wrote nothing");
  }
  assert.equal((await audits("ADMIN_ACTIVATED_LIVE_SHARED_STEP")).length, auditsBefore);

  // An activation step without a release still works and leaves the stop engaged.
  const ok = await post("/admin/live-shared/activate-step", { confirm: true, masterBridgeLiveEnabled: true });
  assert.equal(ok.status, 200);
  assert.equal((await platformStop()).sources.includes("platform_emergency_stop"), true, "activation leaves the stop engaged");

  // The explicit release.
  sessionRole = "USER";
  assert.equal((await post("/admin/trading/reset-kill", { reason: "qa release" })).status, 403, "non-operator refused");
  sessionRole = "ADMIN";
  assert.equal((await post("/admin/trading/reset-kill", { reason: "x" })).status, 400, "reason required");
  const rel = await post("/admin/trading/reset-kill", { reason: "qa route release" });
  assert.equal(rel.status, 200);
  assert.equal((rel.body.settings as Record<string, unknown>).emergencyKillSwitch, false);
  for (const r of await rows()) assert.equal(r.emergencyKillSwitch, false, "every row released");

  // The safety-core reset route goes through the same operation.
  await engagePlatformStop({ reason: "qa route 2", actorUserId: adminId, source: "admin_trading_emergency_kill" });
  await setCore(true);
  const bad = await post("/system/kill-switch/reset", { resetBy: "qa", acknowledgement: "no" });
  assert.equal(bad.status, 409);
  assert.equal(bad.body.ok, false);
  const sys = await post("/system/kill-switch/reset", { resetBy: "qa", acknowledgement: "I_UNDERSTAND_RISK" });
  assert.equal(sys.status, 200);
  assert.equal(sys.body.ok, true);
  assert.deepEqual((await platformStop()).sources, ["platform_emergency_stop"], "the system reset released only the safety core");
  await db.update(globalTradingSettingsTable).set({ emergencyKillSwitch: false, killSwitchReason: null, killSwitchEngagedAt: null });
});

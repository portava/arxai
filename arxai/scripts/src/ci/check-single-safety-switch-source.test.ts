// Negative fixtures for check-single-safety-switch-source. Pure, no IO.
import assert from "node:assert/strict";
import { ALLOW, checkAuthorityShape, checkSharedLivePauseShape, checkStopWriterShape, scanFile, staleEntries, SHARED_LIVE_PAUSE_AUTHORITY, STOP_ENGAGE_WRITER } from "./check-single-safety-switch-source.js";

export {};

const one = (key: string, src: string) => scanFile(key, src).length;

// 1. Switch columns through the table object.
assert.equal(one("routes/x.ts", `import { globalTradingSettingsTable } from "@workspace/db";
const r = await db.select({ on: globalTradingSettingsTable.emergencyKillSwitch }).from(globalTradingSettingsTable);`), 1);
assert.equal(one("routes/x.ts", `import { globalTradingSettingsTable as g } from "@workspace/db";
const r = await db.select({ m: g.platformMode }).from(g);`), 1, "import alias");
assert.equal(one("lib/a.ts", `const r = await db.select({ a: schema.globalTradingSettingsTable.liveBrokerExecutionArmed }).from(schema.globalTradingSettingsTable);`), 1, "namespace access");
// Non-switch columns are config, not switches.
assert.deepEqual(scanFile("routes/x.ts", `import { globalTradingSettingsTable } from "@workspace/db";
const r = await db.select({ m: globalTradingSettingsTable.accountRoutingMode }).from(globalTradingSettingsTable).limit(1);`), []);

// 2. Whole-row reads (select() with no column map, relational query).
assert.equal(one("lib/b.ts", `const [g] = await db.select().from(globalTradingSettingsTable).limit(1);`), 1);
assert.equal(one("lib/b.ts", `const [g] = await tx.select().from(globalTradingSettingsTable);`), 1);
assert.equal(one("lib/b.ts", `const g = await db.query.globalTradingSettingsTable.findFirst();`), 1);

// 3. Writes.
assert.equal(one("routes/y.ts", `await db.update(globalTradingSettingsTable).set({ accountRoutingMode: "X" });`), 1);

// 4. safety_core and 5. the arming row outside their owners.
assert.equal(one("routes/z.ts", `import { safetyCoreTable } from "@workspace/db"; const r = await db.select().from(safetyCoreTable);`), 1);
assert.deepEqual(scanFile("lib/safetyCore.ts", `const r = await db.select().from(safetyCoreTable);`), []);
assert.equal(one("routes/z.ts", `const a = await db.select().from(arxLiveArmingTable).where(eq(arxLiveArmingTable.userId, 1));`), 1);
assert.deepEqual(scanFile("lib/live/liveArming.ts", `const a = await db.select().from(arxLiveArmingTable);`), []);

// 6. The raw row loader and 7. the env helper.
assert.equal(one("routes/q.ts", `const row = await loadGlobalTradingSettingsRow();`), 1);
assert.equal(one("routes/q.ts", `const on = isLiveBrokerExecutionEnabledEnv();`), 1);
// Importing alone is not a read.
assert.deepEqual(scanFile("routes/q.ts", `import { isLiveBrokerExecutionEnabledEnv } from "@workspace/domain/safety-contracts/isLiveBrokerExecutionEnabled";`), []);

// 8. Raw SQL.
assert.equal(one("lib/c.ts", "await db.execute(sql`SELECT emergency_kill_switch FROM global_trading_settings`);"), 1);
assert.equal(one("lib/c.ts", "await pool.query('SELECT platform_mode, live_enabled FROM global_trading_settings LIMIT 1');"), 1);
assert.equal(one("lib/c.ts", "await pool.query('select * from safety_core');"), 1);
// Reason codes and comments are not SQL.
assert.deepEqual(scanFile("lib/c.ts", `const code = "KILL_SWITCH_ENGAGED"; // reads emergency_kill_switch elsewhere`), []);

// 9. One install-wide stop read on its own (a pre-check must read platformStop()).
assert.equal(one("lib/d.ts", `const sw = await readPlatformSwitches(); if (sw.emergencyStop.engaged) refuse();`), 1, "emergency stop alone");
assert.equal(one("lib/d.ts", `const env = await getEnvelope(uid); if (env.emergencyKillSwitch) refuse();`), 1, "envelope emergency field alone");
assert.equal(one("lib/d.ts", `const sc = await readSafetyCoreSwitch(); if (sc.engaged) refuse();`), 1, "safety-core switch alone");
assert.equal(one("lib/d.ts", `import { getStatus } from "../safetyCore.js"; const s = await getStatus(); if (s.killSwitchEngaged) refuse();`), 1, "safetyCore getStatus kill switch");
assert.equal(one("routes/d.ts", `const { getStatus: g } = await import("../lib/safetyCore.js"); const s = await g(); if (s.killSwitchEngaged) refuse();`), 1, "dynamic import of the safety core");
// The trader's own kill switch (arming row) is not an install-wide stop.
assert.deepEqual(scanFile("lib/d.ts", `const a = await getMyArming(uid); if (a.killSwitchEngaged) refuse();`), []);
// Reading both through the authority passes.
assert.deepEqual(scanFile("lib/d.ts", `import { platformStop, preCheckStopRefusal } from "../safety/platformSwitches.js";
const stop = preCheckStopRefusal(await platformStop(), { own: "safety_core_kill_switch", opensNewRisk: true, venue: "LIVE" });
if (stop.engaged) refuse(stop.reason);`), []);
// An object-literal key is not a read.
assert.deepEqual(scanFile("lib/d.ts", `const out = { emergencyKillSwitch: true, killSwitchEngaged: false };`), []);
// The safety-core owner reads its own row.
assert.deepEqual(scanFile("lib/safetyCore.ts", `import { x } from "./safetyCore.js"; if (sc.killSwitchEngaged) y();`), []);
// A reviewed reader is allowlisted for this rule only.
assert.deepEqual(scanFile("lib/assistant/derivedEnvelope.ts", `const on = env.emergencyKillSwitch;`), []);
assert.equal(one("lib/assistant/derivedEnvelope.ts", `const on = env.emergencyKillSwitch; const g = await db.select().from(globalTradingSettingsTable);`), 1);
// Reports moved onto platformStop() (round 4) are no longer allowlisted.
assert.equal(one("lib/systemHealth/health.ts", `const sc = await readSafetyCoreSwitch();`), 1, "system health reads platformStop()");
assert.equal(one("routes/adminCockpit.ts", `const sw = await readPlatformSwitches(); const k = sw.emergencyStop.engaged;`), 1, "cockpit reads platformStop()");
// A report reading both stops through the authority, with labelled per-source fields, passes.
assert.deepEqual(scanFile("routes/r.ts", `import { platformStopWith, platformStopReport, stopSourceEngaged } from "../lib/safety/platformSwitches.js";
const stop = await platformStopWith(sw);
res.json({ killSwitchActive: stopSourceEngaged(stop, "platform_emergency_stop"), ...platformStopReport(stop) });`), []);

// The authority itself is exempt.
assert.deepEqual(scanFile("lib/safety/platformSwitches.ts", `const r = await db.select().from(globalTradingSettingsTable);`), []);
assert.deepEqual(scanFile("lib/safety/tradingHalt.ts", `const a = await db.select({ on: arxLiveArmingTable.killSwitchEngaged }).from(arxLiveArmingTable);`), []);

// Allowlisted files may break only their listed rules.
assert.deepEqual(scanFile("routes/adminTrading.ts", `await db.update(globalTradingSettingsTable).set({ accountRoutingMode: "USER_OWNED_MT5" });`), [], "a config write stays with its reviewed writer");

// 10. Engaging the emergency stop goes through the one writer.
assert.equal(one("routes/adminTrading.ts", `await db.update(globalTradingSettingsTable).set({ emergencyKillSwitch: true });`), 1, "an engage write outside the writer fails, even in a reviewed writer");
assert.equal(one("routes/adminLiveSharedActivation.ts", `await tx.update(globalTradingSettingsTable).set({ emergencyKillSwitch: true, liveEnabled: false });`), 1);
assert.equal(one("routes/adminTrading.ts", `const on = true; await db.update(globalTradingSettingsTable).set({ ...{ emergencyKillSwitch: on } });`), 1, "spread of a literal, non-literal value");
assert.equal(one("routes/adminTrading.ts", `const emergencyKillSwitch = true; await db.update(globalTradingSettingsTable).set({ emergencyKillSwitch });`), 1, "shorthand");
assert.equal(one("routes/adminLiveSharedReadiness.ts", `const patch: Record<string, unknown> = {}; patch.emergencyKillSwitch = true; await db.update(globalTradingSettingsTable).set(patch);`), 1, "patch object");
assert.equal(one("routes/adminLiveSharedReadiness.ts", `patch["emergencyKillSwitch"] = 1;`), 1, "element access");
// 10 (round 5, owner decision 1). Releasing a stop goes through the one release operation.
assert.equal(one("routes/adminLiveSharedReadiness.ts", `patch.emergencyKillSwitch = false; await db.update(globalTradingSettingsTable).set(patch);`), 1, "activation may not release (patch object)");
assert.equal(one("routes/adminTrading.ts", `await db.update(globalTradingSettingsTable).set({ emergencyKillSwitch: false, killSwitchReason: null });`), 1, "a release write outside the writer fails, even in a reviewed writer");
assert.equal(one("routes/adminTrading.ts", `await db.update(globalTradingSettingsTable).set({ ...{ emergencyKillSwitch: false } });`), 1, "release through a spread literal");
assert.equal(one("routes/adminLiveSharedReadiness.ts", `patch["emergencyKillSwitch"] = false;`), 1, "release through element access");
assert.equal(one("routes/system.ts", `import { resetKillSwitch } from "../lib/safetyCore.js";\nawait resetKillSwitch(body);`), 1, "the safety core's reset outside the release operation fails");
assert.deepEqual(scanFile("lib/other.ts", `function resetKillSwitch() {}\nresetKillSwitch();`), [], "an unrelated resetKillSwitch (not the safety core's) is not flagged");
assert.deepEqual(scanFile(STOP_ENGAGE_WRITER, `import { resetKillSwitch } from "../safetyCore.js";\nawait resetKillSwitch({ resetBy, acknowledgement });\nawait tx.update(globalTradingSettingsTable).set({ emergencyKillSwitch: false }).returning();`), [], "the release operation itself");
assert.deepEqual(scanFile("routes/adminTrading.ts", `await releasePlatformStop({ stop: "platform_emergency_stop", reason, actor: { userId: 1, role }, source: "admin_trading_reset_kill" });`), [], "a caller of the release operation");
assert.deepEqual(scanFile("routes/x.ts", `res.json({ emergencyKillSwitch: false }); const before = { emergencyKillSwitch: false };`), [], "a report object is not a release");
assert.equal(one("routes/adminTrading.ts", `await db.insert(globalTradingSettingsTable).values({ emergencyKillSwitch: true });`), 1, "insert");
// A report or snapshot object is not a write.
assert.deepEqual(scanFile("routes/x.ts", `const after = { emergencyKillSwitch: true }; res.json({ emergencyKillSwitch: true });`), []);
// The writer itself, and an audited caller.
assert.deepEqual(scanFile(STOP_ENGAGE_WRITER, `await exec.update(globalTradingSettingsTable).set({ emergencyKillSwitch: true, killSwitchReason: r }).returning();`), []);
assert.deepEqual(scanFile("routes/adminTrading.ts", `import { adminActionAuditLogTable } from "@workspace/db/schema";
await engagePlatformStop({ reason, actorUserId: 1, source: "admin_trading_emergency_kill" });
await db.insert(adminActionAuditLogTable).values({ action: "ENGAGE_KILL_SWITCH" });`), []);
assert.equal(one("routes/newEngage.ts", `await engagePlatformStop({ reason, actorUserId: 1, source: "admin_trading_emergency_kill" });`), 1, "an unaudited caller fails");

// The engage writer's shape: every row, all three stop fields and the actor.
const goodWriter = `export async function engagePlatformStop(
  const updated = await exec.update(globalTradingSettingsTable)
    .set({
      emergencyKillSwitch: true,
      killSwitchEngagedAt: engagedAt,
      killSwitchReason: args.reason,
      updatedByAdminId: args.actorUserId,
    })
    .returning();
export async function releasePlatformStop(
  const role = operatorRoleFromSession(args.actor.role);
    const r = await resetKillSwitch({ resetBy, acknowledgement });
  const rows = await db.transaction(async (tx) => {
    const updated = await tx.update(globalTradingSettingsTable)
      .set({
        emergencyKillSwitch: false,
        killSwitchEngagedAt: null,
        killSwitchReason: null,
        updatedByAdminId: args.actor.userId,
      })
      .returning();
    await tx.insert(adminActionAuditLogTable).values({});
  });
}
`;
const writerShape = (src: string | null) => checkStopWriterShape((k) => (k === STOP_ENGAGE_WRITER ? src : null));
assert.deepEqual(writerShape(goodWriter), []);
assert.equal(writerShape(null).length, 1, "writer missing");
assert.equal(writerShape(goodWriter.replace("    .returning();", "    .where(eq(globalTradingSettingsTable.id, 1))\n    .returning();")).length, 1, "engage must set every row");
assert.equal(writerShape(goodWriter.replace("      killSwitchReason: args.reason,\n", "")).length, 1, "reason recorded");
assert.equal(writerShape(goodWriter.replace("      updatedByAdminId: args.actorUserId,\n", "")).length, 1, "actor recorded");
// The release operation's shape (owner decision 1).
assert.equal(writerShape(goodWriter.replace("export async function releasePlatformStop(", "async function other(")).length, 1, "release operation must exist");
assert.equal(writerShape(goodWriter.replace("operatorRoleFromSession(args.actor.role)", "args.actor.role")).length, 1, "release must be authorized");
assert.equal(writerShape(goodWriter.replace("      })\n      .returning();", "      })\n      .where(eq(globalTradingSettingsTable.id, 1))\n      .returning();")).length, 1, "release must clear every row");
assert.equal(writerShape(goodWriter.replace("        killSwitchReason: null,\n", "")).length, 1, "release clears the reason");
assert.equal(writerShape(goodWriter.replace("        killSwitchEngagedAt: null,\n", "")).length, 1, "release clears the time");
assert.equal(writerShape(goodWriter.replace("        killSwitchReason: null,\n", "        killSwitchReason: null,\n        liveBrokerExecutionArmed: true,\n")).length, 1, "release never arms");
assert.equal(writerShape(goodWriter.replace("    await tx.insert(adminActionAuditLogTable).values({});\n", "")).length, 1, "release audited in its transaction");
assert.equal(writerShape(goodWriter.replace("await resetKillSwitch(", "await somethingElse(")).length, 1, "safety-core release goes through its owner");
assert.equal(one("routes/adminTrading.ts", `const [g] = await db.select().from(globalTradingSettingsTable);`), 1, "adminTrading is not allowed whole-row reads");

// Stale allowlist: an entry whose file no longer breaks the rule (or is gone) is reported.
const stale = staleEntries((key) => (key === "routes/adminTrading.ts" ? `export const nothing = 1;` : null));
assert.ok(stale.some((s) => s.startsWith("routes/adminTrading.ts:") && s.includes(`"gts_write"`)));
assert.ok(stale.some((s) => s.includes("no longer exists")));
assert.ok(Object.keys(ALLOW).length > 0);

// Authority shape: losing the strict multi-row combine fails.
const goodSwitches = `export async function readPlatformSwitches(
export function switchesFromRows(
  const engagedRow = rows.find((r) => r.emergencyKillSwitch !== false);
function failClosed(
export async function platformStop(
    return platformStopFrom(sw, sc);
      ["platform_emergency_stop", "safety_core_kill_switch"],
export function preCheckStopRefusal(`;
const goodHalt = `import { x } from "./platformSwitches.js";
  const stop = platformStopForVenue(await platformStop(), venue);
export async function venueTradingVerdict(`;
const shape = (sw: string, halt: string) => checkAuthorityShape((k) => (k.endsWith("platformSwitches.ts") ? sw : halt));
assert.deepEqual(shape(goodSwitches, goodHalt), []);
assert.equal(shape(goodSwitches.replace("rows.find((r) => r.emergencyKillSwitch !== false)", "rows[0]"), goodHalt).length, 1);
assert.equal(shape(goodSwitches, goodHalt.replace("venueTradingVerdict", "other")).length, 1);
assert.equal(shape(goodSwitches.replace("export async function platformStop(", "async function x("), goodHalt).length, 1, "platformStop() must exist");
assert.equal(shape(goodSwitches.replace(`["platform_emergency_stop", "safety_core_kill_switch"]`, "[]"), goodHalt).length, 1, "platformStop() must fail closed on both");
assert.equal(shape(goodSwitches.replace("export function preCheckStopRefusal(", "function y("), goodHalt).length, 1);
assert.equal(shape(goodSwitches, goodHalt.replace("await platformStop()", "await readSafetyCoreSwitch()")).length, 1, "tradingHalt reads platformStop()");

// 11. The shared-live pause flag (owner decision 19): readers and writers go through its authority.
assert.equal(one("lib/live/liveCommandPipeline.ts", `if (pool.sharedLivePaused) return refuse();`), 1, "a direct read of the flag fails");
assert.equal(one("routes/adminAllocations.ts", `await db.update(arxMasterBridgePoolTable).set({ sharedLivePaused: true, pausedReason: r }).where(eq(arxMasterBridgePoolTable.id, id));`), 1, "a direct pause write fails");
assert.equal(one("routes/x.ts", `await db.update(t).set({ ...{ sharedLivePaused: false } });`), 1, "a resume write through a spread fails");
assert.equal(one("lib/live/masterBridgePool.ts", `await db.insert(arxMasterBridgePoolTable).values({ ...baseValues, sharedLivePaused: false });`), 1, "the recompute may not write the flag either");
assert.equal(one("routes/x.ts", "await db.execute(sql`UPDATE arx_master_bridge_pool SET shared_live_paused = true`)"), 1, "raw SQL naming the flag fails");
assert.deepEqual(scanFile("lib/live/liveCommandPipeline.ts", `const p = sharedLivePauseOf(pool); if (p.paused) return refuse(p.reason);`), [], "the authority's reader passes");
assert.deepEqual(scanFile("routes/adminAllocations.ts", `const r = await pauseSharedLive({ scope: { poolId: pool.id }, reason, actor });`), [], "the authority's writer passes");
assert.deepEqual(scanFile(SHARED_LIVE_PAUSE_AUTHORITY, `const paused = pool.sharedLivePaused === true; await tx.update(arxMasterBridgePoolTable).set({ sharedLivePaused: true });`), [], "the authority itself");
assert.deepEqual(scanFile("lib/investor/x.ts", `const r = profile.pausedReason;`), [], "other tables' pausedReason is not the flag");

// Authority shape: one pool row by id, operator-only, audited, never install-wide.
const pauseFn = (name: string) => `export async function ${name}(args: A): Promise<R> {
  const role = operatorRoleFromSession(args.actor.role);
  return db.transaction(async (tx) => {
    const [pool] = await tx.update(arxMasterBridgePoolTable).set({
      sharedLivePaused: true,
    }).where(eq(arxMasterBridgePoolTable.id, scope.poolId)).returning();
    await tx.insert(adminActionAuditLogTable).values({});
  });
}
`;
const goodPause = `export function sharedLivePauseOf(pool: P) {}\n${pauseFn("pauseSharedLive")}${pauseFn("resumeSharedLive")}`;
const pauseShape = (src: string) => checkSharedLivePauseShape((k) => (k === SHARED_LIVE_PAUSE_AUTHORITY ? src : null));
assert.deepEqual(pauseShape(goodPause), []);
assert.equal(pauseShape("").length, 1, "the authority must exist");
assert.equal(pauseShape(goodPause.replace("export async function resumeSharedLive(", "async function other(")).length, 1, "resume must exist");
assert.equal(pauseShape(goodPause.replace("operatorRoleFromSession(args.actor.role)", "args.actor.role")).length, 1, "pause must be authorized");
assert.equal(pauseShape(goodPause.replace(".where(eq(arxMasterBridgePoolTable.id, scope.poolId)).returning()", ".returning()")).length, 1, "an unscoped pause (every pool row) fails");
assert.equal(pauseShape(goodPause.replace("    await tx.insert(adminActionAuditLogTable).values({});\n", "")).length, 1, "pause audited in its transaction");
assert.equal(pauseShape(goodPause.replace("export function sharedLivePauseOf(", "function x(")).length, 1, "the reader must exist");
assert.equal(pauseShape(goodPause + "await db.update(globalTradingSettingsTable).set({ emergencyKillSwitch: true });\n").length, 1, "never install-wide");

console.log("check-single-safety-switch-source fixtures: ok");

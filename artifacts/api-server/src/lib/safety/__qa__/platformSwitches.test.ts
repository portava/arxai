// The one safety-switch read authority (lib/safety/platformSwitches +
// tradingHalt.venueTradingVerdict), on a real database.
//
// Proves:
//   - the schema defaults and DEFAULT_SWITCH_ROW agree (a fresh install is
//     available, stop released, live execution not armed),
//   - a missing settings row fails closed unless the caller asks for the
//     schema defaults or a seed,
//   - with more than one settings row the strictest row wins (stop engaged if
//     ANY row says so; venue / operator arm on only if EVERY row says so),
//   - the venue verdict combines the venue switch and every stop switch,
//   - the switch-free config view carries no switch, and the envelope reads
//     the same answer as the authority,
//   - the trader kill switch written by its owner (liveArming) halts.
//
// The original settings and safety_core rows are restored afterwards.
//
// Run: pnpm --filter @workspace/api-server run test:platform-switches

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { asc, eq, inArray } from "drizzle-orm";
import { arxLiveArmingTable, db, globalTradingSettingsTable, safetyCoreTable, usersTable } from "@workspace/db";
import {
  DEFAULT_SWITCH_ROW,
  SWITCH_FIELDS,
  getGlobalTradingConfig,
  loadGlobalTradingSettingsRow,
  readPlatformSwitches,
  readSafetyCoreSwitch,
} from "../platformSwitches.js";
import { venueTradingVerdict } from "../tradingHalt.js";
import { getEnvelope, getGlobalSettings } from "../../adminTrading/safetyEnvelope.js";
import { engageKillSwitchForUser, releaseKillSwitchForUser } from "../../live/liveArming.js";

type Row = typeof globalTradingSettingsTable.$inferSelect;
type CoreRow = typeof safetyCoreTable.$inferSelect;
const EMAIL = "qa+platform-switches@arx.test";
let saved: Row[] = [];
let savedCore: CoreRow[] = [];
let userId = 0;

before(async () => {
  saved = await db.select().from(globalTradingSettingsTable).orderBy(asc(globalTradingSettingsTable.id));
  savedCore = await db.select().from(safetyCoreTable).orderBy(asc(safetyCoreTable.id));
  await db.delete(usersTable).where(inArray(usersTable.email, [EMAIL]));
  const [u] = await db.insert(usersTable).values({ email: EMAIL, name: "QA switches", role: "USER", isSystemUser: true }).returning({ id: usersTable.id });
  userId = u!.id;
  await db.delete(globalTradingSettingsTable);
});

after(async () => {
  await db.delete(globalTradingSettingsTable);
  if (saved.length) await db.insert(globalTradingSettingsTable).values(saved);
  await db.delete(safetyCoreTable);
  if (savedCore.length) await db.insert(safetyCoreTable).values(savedCore);
  await db.delete(arxLiveArmingTable).where(eq(arxLiveArmingTable.userId, userId));
  await db.delete(usersTable).where(eq(usersTable.id, userId));
});

const setAll = async (patch: Partial<typeof globalTradingSettingsTable.$inferInsert>) => {
  await db.update(globalTradingSettingsTable).set(patch);
};

test("no settings row: fail closed by default; defaults / seed only when asked", async () => {
  await db.delete(globalTradingSettingsTable);
  const closed = await readPlatformSwitches();
  assert.equal(closed.readable, false);
  assert.equal(closed.unreadableReason, "missing");
  assert.equal(closed.emergencyStop.engaged, true);
  assert.deepEqual(closed.venueOpen, { DEMO: false, LIVE: false });
  assert.equal(closed.platformMode, "OFF");
  assert.equal(closed.liveBrokerExecution.enabled, false);
  assert.equal((await db.select().from(globalTradingSettingsTable)).length, 0, "a read never writes");

  const defaults = await readPlatformSwitches({ ifMissing: "defaults" });
  assert.equal(defaults.emergencyStop.engaged, false);
  assert.deepEqual(defaults.venueOpen, { DEMO: true, LIVE: true });
  assert.equal((await db.select().from(globalTradingSettingsTable)).length, 0, "defaults never write");

  const seeded = await readPlatformSwitches({ ifMissing: "seed" });
  assert.equal(seeded.readable, true);
  assert.equal(seeded.rowCount, 1);
  assert.equal(seeded.emergencyStop.engaged, false);
});

test("DEFAULT_SWITCH_ROW matches the schema defaults the seed writes", async () => {
  await db.delete(globalTradingSettingsTable);
  const row = (await loadGlobalTradingSettingsRow())!;
  for (const f of SWITCH_FIELDS) assert.deepEqual(row[f], DEFAULT_SWITCH_ROW[f], f);
});

test("venues follow the platform mode and the enable flags", async () => {
  await setAll({ platformMode: "DEMO", demoEnabled: true, liveEnabled: true, emergencyKillSwitch: false });
  let sw = await readPlatformSwitches();
  assert.deepEqual(sw.venueOpen, { DEMO: true, LIVE: false });
  await setAll({ platformMode: "LIVE", demoEnabled: false, liveEnabled: true });
  sw = await readPlatformSwitches();
  assert.deepEqual(sw.venueOpen, { DEMO: false, LIVE: true });
  await setAll({ platformMode: "live" }); // not a value the admin handler writes → OFF
  sw = await readPlatformSwitches();
  assert.equal(sw.platformMode, "OFF");
  assert.deepEqual(sw.venueOpen, { DEMO: false, LIVE: false });
  await setAll({ platformMode: "LIVE", demoEnabled: true, liveEnabled: true });
});

test("with a stray second row the strictest row wins", async () => {
  await setAll({ platformMode: "LIVE", demoEnabled: true, liveEnabled: true, emergencyKillSwitch: false, liveBrokerExecutionArmed: true });
  const [stray] = await db.insert(globalTradingSettingsTable).values({ emergencyKillSwitch: true, killSwitchReason: "stray" }).returning();
  try {
    let sw = await readPlatformSwitches();
    assert.equal(sw.rowCount, 2);
    assert.equal(sw.emergencyStop.engaged, true, "an engaged stop on ANY row halts");
    assert.equal(sw.emergencyStop.reason, "stray");
    assert.equal(sw.liveBrokerExecution.operatorArmed, false, "the arm is on only if EVERY row is armed");
    // The order path's envelope agrees with the authority.
    assert.equal((await getEnvelope(userId)).emergencyKillSwitch, true);
    assert.equal((await venueTradingVerdict({ userId, venue: "DEMO" })).allowed, false);

    await db.update(globalTradingSettingsTable).set({ emergencyKillSwitch: false, liveEnabled: false }).where(eq(globalTradingSettingsTable.id, stray!.id));
    sw = await readPlatformSwitches();
    assert.equal(sw.emergencyStop.engaged, false);
    assert.equal(sw.venueOpen.LIVE, false, "a venue closed on ANY row is closed");
    assert.equal(sw.venueOpen.DEMO, true);
  } finally {
    await db.delete(globalTradingSettingsTable).where(eq(globalTradingSettingsTable.id, stray!.id));
  }
  await setAll({ liveBrokerExecutionArmed: false });
});

test("venueTradingVerdict: venue switch AND every stop switch", async () => {
  await setAll({ platformMode: "LIVE", demoEnabled: true, liveEnabled: true, emergencyKillSwitch: false, killSwitchReason: null });
  await db.update(safetyCoreTable).set({ killSwitchEngaged: false, killSwitchReason: null });
  let v = await venueTradingVerdict({ userId, venue: "LIVE" });
  assert.equal(v.allowed, true);
  assert.deepEqual(v.reasons, []);

  await setAll({ liveEnabled: false });
  v = await venueTradingVerdict({ userId, venue: "LIVE" });
  assert.equal(v.allowed, false);
  assert.equal(v.venueOpen, false);
  assert.match(v.reasons.join(" "), /live venue is switched off/);
  assert.equal((await venueTradingVerdict({ userId, venue: "PAPER" })).allowed, true, "a venue switch never closes paper");
  await setAll({ liveEnabled: true });

  await setAll({ emergencyKillSwitch: true, killSwitchReason: "qa stop" });
  v = await venueTradingVerdict({ userId, venue: "DEMO" });
  assert.equal(v.allowed, false);
  assert.ok(v.halt.sources.includes("platform_emergency_stop"));
  assert.match(v.reasons.join(" "), /qa stop/);
  assert.equal((await venueTradingVerdict({ userId, venue: "PAPER" })).allowed, true, "the platform stop never halts paper");
  await setAll({ emergencyKillSwitch: false, killSwitchReason: null });

  // The trader's own kill switch, written by its one owner, halts every venue.
  await engageKillSwitchForUser({ userId, reason: "qa pause" });
  for (const venue of ["PAPER", "DEMO", "LIVE"] as const) {
    const t = await venueTradingVerdict({ userId, venue });
    assert.equal(t.allowed, false, venue);
    assert.ok(t.halt.sources.includes("trader_kill_switch"), venue);
  }
  await releaseKillSwitchForUser({ userId });
  assert.equal((await venueTradingVerdict({ userId, venue: "LIVE" })).allowed, true);
});

test("the safety-core kill switch is read without seeding and halts", async () => {
  if (!(await db.select().from(safetyCoreTable).limit(1)).length) await db.insert(safetyCoreTable).values({});
  await db.update(safetyCoreTable).set({ killSwitchEngaged: true, killSwitchReason: "qa core" });
  const sc = await readSafetyCoreSwitch();
  assert.equal(sc.engaged, true);
  assert.equal(sc.reason, "qa core");
  const v = await venueTradingVerdict({ userId, venue: "PAPER" });
  assert.equal(v.allowed, false);
  assert.ok(v.halt.sources.includes("safety_core_kill_switch"));
  await db.update(safetyCoreTable).set({ killSwitchEngaged: false, killSwitchReason: null });
});

test("the config view carries no switch", async () => {
  const cfg = (await getGlobalTradingConfig())! as Record<string, unknown>;
  const viaEnvelope = (await getGlobalSettings())! as Record<string, unknown>;
  for (const f of SWITCH_FIELDS) {
    assert.equal(f in cfg, false, f);
    assert.equal(f in viaEnvelope, false, f);
  }
  assert.ok("accountRoutingMode" in cfg);
});

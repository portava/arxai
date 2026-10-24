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
//   - the trader kill switch written by its owner (liveArming) halts,
//   - platformStop() is one answer for both install-wide stops (every
//     combination, fail closed when either read errors), the Risk Governor's
//     tradingHalt reads it, and the pre-check rule (preCheckStopRefusal) only
//     ever adds refusals: its own stop refuses as before, the other stop
//     refuses only new risk on a venue it halts,
//   - the trade-action guard refuses an OPEN on either stop and still lets a
//     CLOSE past the emergency stop (left to the governor).
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
  platformStop,
  platformStopForVenue,
  preCheckStopRefusal,
  readPlatformSwitches,
  readSafetyCoreSwitch,
  type PlatformStop,
} from "../platformSwitches.js";
import { loadPlatformHalt, loadTradingHalt, venueTradingVerdict } from "../tradingHalt.js";
import { runActionGuards } from "../../tradeAction/guards.js";
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

// ── Platform stop: both install-wide stops, one answer ─────────────────────

const ensureCore = async () => {
  if (!(await db.select().from(safetyCoreTable).limit(1)).length) await db.insert(safetyCoreTable).values({});
};
const setStops = async (emergency: boolean, core: boolean) => {
  await setAll({ emergencyKillSwitch: emergency, killSwitchReason: emergency ? "qa emergency" : null });
  await db.update(safetyCoreTable).set({ killSwitchEngaged: core, killSwitchReason: core ? "qa core" : null });
};

test("platformStop: every combination of the two stops", async () => {
  await ensureCore();
  if (!(await db.select().from(globalTradingSettingsTable).limit(1)).length) await loadGlobalTradingSettingsRow();
  const cases: Array<[boolean, boolean, string[]]> = [
    [false, false, []],
    [true, false, ["platform_emergency_stop"]],
    [false, true, ["safety_core_kill_switch"]],
    [true, true, ["platform_emergency_stop", "safety_core_kill_switch"]],
  ];
  for (const [emergency, core, sources] of cases) {
    await setStops(emergency, core);
    const stop = await platformStop();
    const label = `emergency=${emergency} core=${core}`;
    assert.equal(stop.engaged, sources.length > 0, label);
    assert.deepEqual(stop.sources, sources, label);
    assert.equal(stop.readable, true, label);
    if (emergency) assert.match(stop.reason!, /emergency stop.*qa emergency/, label);
    else if (core) assert.match(stop.reason!, /safety-core kill switch.*qa core/, label);
    else assert.equal(stop.reason, null, label);
    // The Risk Governor's halt reads the same answer.
    const halt = await loadPlatformHalt();
    assert.deepEqual(halt.sources, sources, `loadPlatformHalt ${label}`);
    const paper = await loadTradingHalt({ userId, venue: "PAPER" });
    assert.deepEqual(paper.sources, sources.filter((s) => s !== "platform_emergency_stop"), `paper halt ${label}`);
  }
  await setStops(false, false);
});

test("platformStop: no settings row reads released (schema defaults); never writes", async () => {
  const keep = await db.select().from(globalTradingSettingsTable).orderBy(asc(globalTradingSettingsTable.id));
  await db.delete(globalTradingSettingsTable);
  try {
    await db.update(safetyCoreTable).set({ killSwitchEngaged: false, killSwitchReason: null });
    const stop = await platformStop();
    assert.equal(stop.engaged, false);
    assert.equal((await db.select().from(globalTradingSettingsTable)).length, 0, "a read never writes");
  } finally {
    await db.delete(globalTradingSettingsTable);
    if (keep.length) await db.insert(globalTradingSettingsTable).values(keep);
  }
});

test("platformStop: fail closed when either read errors or is unreadable", async () => {
  const released = async () => ({ readable: true, emergencyStop: { engaged: false, reason: null, engagedAt: null } });
  const coreReleased = async () => ({ readable: true, engaged: false, reason: null });
  const boom = async (): Promise<never> => { throw new Error("db down"); };

  const both = ["platform_emergency_stop", "safety_core_kill_switch"];
  let stop = await platformStop({ readSwitches: boom, readSafetyCore: coreReleased });
  assert.deepEqual([stop.engaged, stop.readable, stop.sources], [true, false, both], "settings read throws");
  stop = await platformStop({ readSwitches: released, readSafetyCore: boom });
  assert.deepEqual([stop.engaged, stop.readable, stop.sources], [true, false, both], "safety-core read throws");

  // The real readers never throw; they report unreadable = engaged.
  stop = await platformStop({
    readSwitches: async () => ({ readable: false, emergencyStop: { engaged: true, reason: "state unreadable", engagedAt: null } }),
    readSafetyCore: coreReleased,
  });
  assert.deepEqual(stop.sources, ["platform_emergency_stop"]);
  assert.equal(stop.readable, false);
  assert.equal(stop.detail.platform_emergency_stop, "state unreadable");
  stop = await platformStop({
    readSwitches: released,
    readSafetyCore: async () => ({ readable: false, engaged: true, reason: "state unreadable" }),
  });
  assert.deepEqual(stop.sources, ["safety_core_kill_switch"]);
  assert.equal(stop.readable, false);

  stop = await platformStop({ readSwitches: released, readSafetyCore: coreReleased });
  assert.deepEqual([stop.engaged, stop.readable], [false, true]);
});

test("preCheckStopRefusal: own stop refuses as before; the other only adds new-risk refusals", () => {
  const mk = (sources: PlatformStop["sources"]): PlatformStop => ({
    engaged: sources.length > 0, sources, reason: sources.length ? "x" : null,
    detail: Object.fromEntries(sources.map((s) => [s, "why"])), readable: true,
  });
  const E = "platform_emergency_stop" as const;
  const C = "safety_core_kill_switch" as const;
  const combos = [mk([]), mk([E]), mk([C]), mk([E, C])];
  for (const own of [E, C]) {
    for (const stop of combos) {
      for (const venue of ["PAPER", "DEMO", "LIVE"] as const) {
        for (const opensNewRisk of [false, true]) {
          const r = preCheckStopRefusal(stop, { own, opensNewRisk, venue });
          const label = `own=${own} stop=${stop.sources.join("+") || "none"} venue=${venue} open=${opensNewRisk}`;
          // Never looser than reading only the own stop.
          if (stop.sources.includes(own)) assert.equal(r.engaged, true, label);
          // The other stop: only new risk, and the emergency stop never on paper.
          const other = own === E ? C : E;
          const otherApplies = stop.sources.includes(other) && opensNewRisk && !(other === E && venue === "PAPER");
          assert.equal(r.sources.includes(other), otherApplies, label);
          assert.equal(r.engaged, stop.sources.includes(own) || otherApplies, label);
        }
      }
    }
  }
  // Fail closed passes through: an unreadable stop (both sources) refuses an open everywhere.
  const unreadable: PlatformStop = { ...mk([E, C]), readable: false };
  assert.equal(preCheckStopRefusal(unreadable, { own: C, opensNewRisk: true, venue: "LIVE" }).engaged, true);
  assert.equal(preCheckStopRefusal(unreadable, { own: E, opensNewRisk: false, venue: "PAPER" }).engaged, true);
  // The paper simulator is not halted by the emergency stop.
  assert.deepEqual(platformStopForVenue(mk([E, C]), "PAPER").sources, [C]);
  assert.deepEqual(platformStopForVenue(mk([E]), "LIVE").sources, [E]);
});

test("trade-action guard: either stop refuses an OPEN; a CLOSE passes the emergency stop", async () => {
  await ensureCore();
  await setAll({ platformMode: "LIVE", demoEnabled: true, liveEnabled: true });
  const base = {
    userId, actionId: 0, symbol: "EURUSD", side: "BUY", lotSize: 0.01, tradeKey: null,
    confirmedByUser: true, expiresAt: null, previewMode: true,
  };
  const killCheck = async (actionType: string, requestedMode: "SIMULATED" | "DEMO" | "LIVE") => {
    const r = await runActionGuards({ ...base, actionType, requestedMode });
    return r.checks.find((c) => c.id === "kill_switch");
  };

  await setStops(false, false);
  assert.equal((await killCheck("OPEN", "DEMO"))?.passed, true, "released");

  // The safety-core kill switch: refuses every action on every venue (as before).
  await setStops(false, true);
  for (const mode of ["SIMULATED", "DEMO", "LIVE"] as const) {
    for (const action of ["OPEN", "CLOSE"]) {
      const c = await killCheck(action, mode);
      assert.equal(c?.passed, false, `core ${action} ${mode}`);
      assert.equal(c?.detail, "Emergency stop is engaged. No trade actions can be confirmed.", "message unchanged");
    }
  }

  // The platform emergency stop: now also refuses an OPEN on DEMO/LIVE here
  // (the governor refuses it anyway); paper and closes are left as they were.
  await setStops(true, false);
  for (const mode of ["DEMO", "LIVE"] as const) {
    const c = await killCheck("OPEN", mode);
    assert.equal(c?.passed, false, `emergency OPEN ${mode}`);
    assert.match(c!.detail!, /platform emergency stop.*qa emergency/);
  }
  assert.equal((await killCheck("OPEN", "SIMULATED"))?.passed, true, "the emergency stop never halts paper");
  assert.equal((await killCheck("CLOSE", "LIVE"))?.passed, true, "a close is left to the governor");

  // Unreadable safety core (prefetched answer) fails closed.
  const r = await runActionGuards({
    ...base, actionType: "CLOSE", requestedMode: "LIVE",
    prefetched: { platformStop: await platformStop({ readSwitches: async () => { throw new Error("x"); } }) },
  });
  assert.equal(r.failedCheckId, "kill_switch");

  await setStops(false, false);
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

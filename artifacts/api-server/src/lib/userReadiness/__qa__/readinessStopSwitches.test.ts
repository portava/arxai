// Readiness reports the live stop from the switches the order path enforces
// (lib/safety/tradingHalt + the admin's live venue), not the legacy
// live_trading_state row. Round 5 (owner decision 2): the broker's operator
// controls (broker_health_state execution disabled / maintenance) also read as
// a platform-wide stop for new live risk.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { asc, eq, inArray } from "drizzle-orm";
import { brokerHealthStateTable, db, globalTradingSettingsTable, liveTradingStateTable, usersTable } from "@workspace/db";
import { evaluateUserReadiness } from "../engine.js";
import { getGlobalSettings } from "../../adminTrading/safetyEnvelope.js";

const EMAIL = "qa+readiness-stop@arx.test";
let userId = 0;
let original: typeof globalTradingSettingsTable.$inferSelect | null = null;
let savedBroker: Array<typeof brokerHealthStateTable.$inferSelect> = [];
const setBroker = async (executionEnabled: boolean, maintenanceMode: boolean) => {
  await db.delete(brokerHealthStateTable);
  await db.insert(brokerHealthStateTable).values({ executionEnabled, maintenanceMode });
};

const stopItem = async () => (await evaluateUserReadiness(userId)).statuses.find((s) => s.id === "paper_only_guard_active")!;
const setGlobal = async (patch: Partial<typeof globalTradingSettingsTable.$inferInsert>) => {
  await db.update(globalTradingSettingsTable).set(patch).where(eq(globalTradingSettingsTable.id, original!.id));
};

before(async () => {
  await db.delete(usersTable).where(inArray(usersTable.email, [EMAIL]));
  const [u] = await db.insert(usersTable).values({ email: EMAIL, name: "QA readiness", role: "USER", isSystemUser: true }).returning({ id: usersTable.id });
  userId = u!.id;
  await getGlobalSettings();
  original = (await db.select().from(globalTradingSettingsTable).orderBy(asc(globalTradingSettingsTable.id)).limit(1))[0] ?? null;
  savedBroker = await db.select().from(brokerHealthStateTable).orderBy(asc(brokerHealthStateTable.id));
  await setBroker(true, false);
});

after(async () => {
  if (original) {
    await setGlobal({ platformMode: original.platformMode, liveEnabled: original.liveEnabled, emergencyKillSwitch: original.emergencyKillSwitch, killSwitchReason: original.killSwitchReason });
  }
  await db.delete(brokerHealthStateTable);
  if (savedBroker.length) await db.insert(brokerHealthStateTable).values(savedBroker);
  await db.delete(usersTable).where(eq(usersTable.id, userId));
});

test("an open live venue with no stop engaged reports no platform-wide stop, whatever live_trading_state says", async () => {
  await setGlobal({ platformMode: "LIVE", liveEnabled: true, emergencyKillSwitch: false });
  const legacy = await db.select({ id: liveTradingStateTable.id }).from(liveTradingStateTable).limit(1);
  const item = await stopItem();
  assert.equal(item.status, "pass");
  assert.match(item.userFriendlyExplanation, /No platform-wide stop is engaged/, `legacy rows: ${legacy.length}`);
  assert.equal((await evaluateUserReadiness(userId)).liveExecutionHardLockActive, false);
});

test("the platform emergency stop reads as a platform-wide live stop", async () => {
  await setGlobal({ platformMode: "LIVE", liveEnabled: true, emergencyKillSwitch: true, killSwitchReason: "qa" });
  const r = await evaluateUserReadiness(userId);
  assert.equal(r.liveExecutionHardLockActive, true);
  assert.equal(r.ready_for_live, false);
  assert.match(r.statuses.find((s) => s.id === "paper_only_guard_active")!.userFriendlyExplanation, /emergency stop/);
});

test("a live venue switched off by the admin reads as a platform-wide live stop", async () => {
  await setGlobal({ platformMode: "LIVE", liveEnabled: false, emergencyKillSwitch: false });
  const item = await stopItem();
  assert.match(item.userFriendlyExplanation, /live venue is switched off/);
});

test("broker execution disabled or maintenance reads as a platform-wide live stop (owner decision 2)", async () => {
  await setGlobal({ platformMode: "LIVE", liveEnabled: true, emergencyKillSwitch: false });
  await setBroker(false, false);
  let item = await stopItem();
  assert.match(item.userFriendlyExplanation, /Broker execution is disabled/);
  assert.equal((await evaluateUserReadiness(userId)).liveExecutionHardLockActive, true);
  await setBroker(true, true);
  item = await stopItem();
  assert.match(item.userFriendlyExplanation, /maintenance mode/);
  await db.delete(brokerHealthStateTable);
  item = await stopItem();
  assert.match(item.userFriendlyExplanation, /Broker execution is disabled/, "no row yet: schema default (execution not enabled)");
  await setBroker(true, false);
  assert.equal((await evaluateUserReadiness(userId)).liveExecutionHardLockActive, false);
});

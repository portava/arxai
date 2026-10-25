// Local test database only: replaces control fixtures and restores every row.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, pool, globalTradingSettingsTable, safetyCoreTable, brokerHealthStateTable } from "@workspace/db";
import { migrationChecks, ownerlessRows, tradingStatus } from "../productionReadinessCheck.js";

let globals: typeof globalTradingSettingsTable.$inferSelect[];
let cores: typeof safetyCoreTable.$inferSelect[];
let brokers: typeof brokerHealthStateTable.$inferSelect[];
before(async () => {
  globals = await db.select().from(globalTradingSettingsTable);
  cores = await db.select().from(safetyCoreTable);
  brokers = await db.select().from(brokerHealthStateTable);
});
after(async () => {
  await db.delete(globalTradingSettingsTable);
  await db.delete(safetyCoreTable);
  await db.delete(brokerHealthStateTable);
  if (globals.length) await db.insert(globalTradingSettingsTable).values(globals);
  if (cores.length) await db.insert(safetyCoreTable).values(cores);
  if (brokers.length) await db.insert(brokerHealthStateTable).values(brokers);
  await pool.end();
});
beforeEach(async () => {
  await db.delete(globalTradingSettingsTable);
  await db.delete(safetyCoreTable);
  await db.delete(brokerHealthStateTable);
  await db.insert(globalTradingSettingsTable).values({ platformMode: "LIVE", emergencyKillSwitch: false, demoEnabled: true, liveEnabled: true });
  await db.insert(safetyCoreTable).values({ killSwitchEngaged: false });
  await db.insert(brokerHealthStateTable).values({ executionEnabled: true, maintenanceMode: false });
});

test("every Tier 1 migration has schema indicators on a migrated database", async () => {
  const m = await migrationChecks();
  assert.equal(m.length, 9);
  assert.ok(m.some(c => c.name === "2026-10-25_trade_action_request_key" && c.ok));
  assert.deepEqual(m.filter(c => !c.ok).map(c => c.name), []);
});

test("released stops and open controls pass without arming LIVE", async () => {
  const result = await tradingStatus();
  assert.equal(result.verdict, "TRADING AVAILABLE");
  assert.match(result.checks.find(c => c.name === "live execution arm (informational)")!.detail, /operator disarmed/);
});

test("a stricter duplicate cannot be hidden by the lowest-id row", async () => {
  await db.insert(globalTradingSettingsTable).values({ emergencyKillSwitch: true, killSwitchReason: "qa" });
  const result = await tradingStatus();
  assert.equal(result.verdict, "TRADING HALTED");
  assert.match(result.checks.find(c => c.name === "platform emergency stop")!.detail, /ENGAGED \(qa\).*owner\/operator/);
  assert.equal(result.checks.find(c => c.name === "global settings inventory")!.ok, false);
});

test("either install-wide stop halts readiness", async () => {
  await db.update(safetyCoreTable).set({ killSwitchEngaged: true });
  assert.equal((await tradingStatus()).verdict, "TRADING HALTED");
});

test("SIMULATED and noncanonical modes cannot report broker venues open", async () => {
  for (const platformMode of ["SIMULATED", "live", "OFF"]) {
    await db.update(globalTradingSettingsTable).set({ platformMode });
    const result = await tradingStatus();
    assert.equal(result.verdict, "TRADING HALTED");
    assert.equal(result.checks.find(c => c.name === "demo venue")!.ok, false);
    assert.equal(result.checks.find(c => c.name === "live venue")!.ok, false);
  }
});

test("missing, disabled and maintenance broker controls cannot pass", async () => {
  await db.update(brokerHealthStateTable).set({ executionEnabled: false });
  assert.equal((await tradingStatus()).verdict, "TRADING HALTED");
  await db.update(brokerHealthStateTable).set({ executionEnabled: true, maintenanceMode: true });
  assert.equal((await tradingStatus()).verdict, "TRADING HALTED");
  await db.delete(brokerHealthStateTable);
  assert.equal((await tradingStatus()).verdict, "TRADING HALTED");
});

test("missing settings remain unknown and are never seeded", async () => {
  await db.delete(globalTradingSettingsTable);
  assert.equal((await tradingStatus()).verdict, "UNKNOWN");
  assert.equal((await db.select().from(globalTradingSettingsTable)).length, 0);
});

test("the check writes nothing to any control table", async () => {
  const snapshot = async () => ({
    global: await db.select().from(globalTradingSettingsTable),
    core: await db.select().from(safetyCoreTable),
    broker: await db.select().from(brokerHealthStateTable),
  });
  const before = await snapshot();
  await migrationChecks(); await tradingStatus(); await ownerlessRows();
  assert.deepEqual(await snapshot(), before);
});

// Fresh-install trading defaults, on a real database. Owner decision
// 2026-11-04 (fail-closed) replaced the 2026-10-24 "trading on by default".
//
// Proves:
//   - with no global_trading_settings row (a fresh install), the platform
//     emergency stop does not halt DEMO or LIVE (the mode/venue switches do),
//   - the singleton seeded on first read comes up OFF with demo and live
//     disabled and the emergency stop released,
//   - an engaged stop still halts both broker venues, and never paper.
//
// The original settings rows are restored afterwards.
//
// Run: pnpm --filter @workspace/api-server run test:trading-on-by-default

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db, globalTradingSettingsTable } from "@workspace/db";
import { loadTradingHalt } from "../tradingHalt.js";
import { loadGlobalTradingSettingsRow } from "../platformSwitches.js";

type Row = typeof globalTradingSettingsTable.$inferSelect;
let saved: Row[] = [];

before(async () => {
  saved = await db.select().from(globalTradingSettingsTable);
  await db.delete(globalTradingSettingsTable);
});

after(async () => {
  await db.delete(globalTradingSettingsTable);
  if (saved.length) await db.insert(globalTradingSettingsTable).values(saved);
});

const platformStop = async (venue: "DEMO" | "LIVE" | "PAPER") =>
  (await loadTradingHalt({ userId: -1, venue })).sources.includes("platform_emergency_stop");

test("a fresh install (no settings row) is not halted by the platform stop", async () => {
  assert.equal(await platformStop("DEMO"), false);
  assert.equal(await platformStop("LIVE"), false);
});

test("the seeded singleton is fail-closed: OFF, demo and live disabled, stop released", async () => {
  const g = (await loadGlobalTradingSettingsRow())!;
  assert.equal(g.platformMode, "OFF");
  assert.equal(g.demoEnabled, false);
  assert.equal(g.liveEnabled, false);
  assert.equal(g.emergencyKillSwitch, false);
  assert.equal(await platformStop("LIVE"), false);
});

test("an engaged stop halts DEMO and LIVE, never paper", async () => {
  const g = (await loadGlobalTradingSettingsRow())!;
  await db.update(globalTradingSettingsTable).set({ emergencyKillSwitch: true }).where(eq(globalTradingSettingsTable.id, g.id));
  assert.equal(await platformStop("DEMO"), true);
  assert.equal(await platformStop("LIVE"), true);
  assert.equal(await platformStop("PAPER"), false);
});

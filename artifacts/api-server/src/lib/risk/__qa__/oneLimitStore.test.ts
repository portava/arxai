// One trader-editable limit store: the fold migration keeps every trader's
// effective limits, and the older settings page reads and writes limits in
// user_risk_settings while its preferences stay in risk_settings.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inArray } from "drizzle-orm";
import { db, pool, riskSettingsTable, userRiskSettingsTable } from "@workspace/db";
import { getOrCreateUserRiskSettings, updateUserRiskSettings } from "../userRiskSettings.js";
import { loadEffectiveLimits } from "../../riskGovernor/enforce.js";
import { PLATFORM_RISK_CEILINGS } from "../../riskGovernor/preTrade.js";

const MIGRATION = join(dirname(fileURLToPath(import.meta.url)), "../../../../../../lib/db/migrations/2026-10-24_one_limit_store.sql");
const U = { legacyOnly: 990_101, both: 990_102, userOnly: 990_103, defaults: 990_104, page: 990_105 };
const IDS = Object.values(U);

async function clean() {
  await db.delete(riskSettingsTable).where(inArray(riskSettingsTable.userId, IDS));
  await db.delete(userRiskSettingsTable).where(inArray(userRiskSettingsTable.userId, IDS));
}
const runMigration = async () => { await pool.query(readFileSync(MIGRATION, "utf8")); };
const userRow = async (userId: number) =>
  (await db.select().from(userRiskSettingsTable).where(inArray(userRiskSettingsTable.userId, [userId])))[0]!;

before(clean);
after(clean);

test("fold migration: effective limits are unchanged, the edited page values carry over, and it is idempotent", async () => {
  // Legacy page only, edited: tighter than the Risk Governor defaults.
  await db.insert(riskSettingsTable).values({
    userId: U.legacyOnly, riskPerTradePct: 0.5, maxDailyLossPct: 2, maxWeeklyLossPct: 4, maxOpenTrades: 2,
    maxTradesPerDay: 4, maxLotSize: 0.1, stopAfterLosingStreak: 2, cooldownAfterLossMinutes: 60,
  });
  // Both pages: the strictest of each pair was enforced before.
  await db.insert(riskSettingsTable).values({
    userId: U.both, riskPerTradePct: 2, maxDailyLossPct: 1, maxWeeklyLossPct: 5, maxOpenTrades: 5, maxLotSize: 0.3,
    stopAfterLosingStreak: 3, cooldownAfterLossMinutes: 30,
  });
  await db.insert(userRiskSettingsTable).values({
    userId: U.both, maxRiskPerTradePercent: 0.75, maxDailyLossPercent: 3, maxOpenTrades: 2, maxPositionSize: 0.5,
    maxConsecutiveLosses: 5, cooldownAfterLossMinutes: 10, maxWeeklyLossPercent: 8,
  });
  // Risk Governor page only: untouched.
  await db.insert(userRiskSettingsTable).values({ userId: U.userOnly, maxRiskPerTradePercent: 0.4 });

  const before = {
    legacyOnly: await loadEffectiveLimitsWithLegacy(U.legacyOnly),
    both: await loadEffectiveLimitsWithLegacy(U.both),
  };
  await runMigration();
  await runMigration();

  const lo = await userRow(U.legacyOnly);
  assert.equal(lo.maxRiskPerTradePercent, 0.5);
  assert.equal(lo.maxDailyLossPercent, 2);
  assert.equal(lo.maxOpenTrades, 2);
  assert.equal(lo.maxTradesPerDay, 4);
  assert.equal(lo.maxPositionSize, 0.1);
  assert.equal(lo.maxWeeklyLossPercent, 4, "the weekly cap the page showed is now in force");
  assert.equal(lo.maxConsecutiveLosses, 2);
  assert.equal(lo.cooldownAfterLossMinutes, 60);
  assert.ok(lo.legacyMergedAt);

  const b = await userRow(U.both);
  assert.equal(b.maxRiskPerTradePercent, 0.75);
  assert.equal(b.maxDailyLossPercent, 1);
  assert.equal(b.maxOpenTrades, 2);
  assert.equal(b.maxPositionSize, 0.3);
  assert.equal(b.maxConsecutiveLosses, 5, "a page default (3) never tightens the trader's own choice");
  assert.equal(b.cooldownAfterLossMinutes, 10, "a page default (30) never overrides the trader's own choice");
  assert.equal(b.maxWeeklyLossPercent, 8, "a page default (5) never tightens a set weekly cap");

  const after = { legacyOnly: await loadEffectiveLimits(U.legacyOnly), both: await loadEffectiveLimits(U.both) };
  for (const k of ["legacyOnly", "both"] as const) {
    for (const f of ["maxLotSize", "maxRiskPerTradePercent", "maxDailyLossPercent"] as const) {
      assert.equal(after[k][f], before[k][f], `${k}.${f} unchanged`);
    }
    assert.equal(after[k].discipline.maxOpenTrades, before[k].discipline.maxOpenTrades, `${k}.maxOpenTrades unchanged`);
    assert.equal(after[k].discipline.maxTradesPerDay, before[k].discipline.maxTradesPerDay, `${k}.maxTradesPerDay unchanged`);
  }
  assert.equal((await userRow(U.userOnly)).maxRiskPerTradePercent, 0.4);
  assert.equal((await userRow(U.userOnly)).legacyMergedAt, null, "no legacy row, nothing folded");
});

test("older page: limits read from and write to user_risk_settings; preferences stay in risk_settings", async () => {
  const s = await getOrCreateUserRiskSettings(U.page);
  assert.equal(s.maxLotSize, PLATFORM_RISK_CEILINGS.maxLotSize, "no own lot cap shows the platform ceiling in force");
  assert.equal(s.maxWeeklyLossPct, 0, "no weekly cap reads as off");

  const u = await updateUserRiskSettings(U.page, { maxLotSize: 0.2, riskPerTradePct: 0.3, maxWeeklyLossPct: 6, minConfidenceScore: 82, liveLocked: true });
  assert.equal(u.maxLotSize, 0.2);
  assert.equal(u.minConfidenceScore, 82);
  const row = await userRow(U.page);
  assert.equal(row.maxPositionSize, 0.2);
  assert.equal(row.maxRiskPerTradePercent, 0.3);
  assert.equal(row.maxWeeklyLossPercent, 6);
  const [prefs] = await db.select().from(riskSettingsTable).where(inArray(riskSettingsTable.userId, [U.page]));
  assert.equal(prefs!.minConfidenceScore, 82);
  assert.equal(prefs!.liveLocked, true);
  assert.equal(prefs!.maxLotSize, 0.1, "the legacy limit column is no longer written");

  const L = await loadEffectiveLimits(U.page);
  assert.equal(L.maxLotSize, 0.2, "the governor enforces what the older page saved");
  assert.equal(L.sources["maxLotSize"], "user_risk_settings.max_position_size");

  await updateUserRiskSettings(U.page, { maxWeeklyLossPct: 0, maxLotSize: 0 });
  const off = await userRow(U.page);
  assert.equal(off.maxWeeklyLossPercent, null, "0 switches the weekly cap off");
  assert.equal(off.maxPositionSize, null, "0 clears the own lot cap (platform ceiling applies)");
});

// The pre-fold resolver took the strictest of both rows; compute it the same
// way here so the test pins "unchanged" against the old behaviour.
async function loadEffectiveLimitsWithLegacy(userId: number) {
  const L = await loadEffectiveLimits(userId);
  const [l] = await db.select().from(riskSettingsTable).where(inArray(riskSettingsTable.userId, [userId]));
  const m = (a: number | null, b: number | null | undefined) => (b != null && b > 0 && (a == null || b < a) ? b : a);
  return {
    maxLotSize: m(L.maxLotSize, l?.maxLotSize),
    maxRiskPerTradePercent: m(L.maxRiskPerTradePercent, l?.riskPerTradePct),
    maxDailyLossPercent: m(L.maxDailyLossPercent, l?.maxDailyLossPct),
    discipline: {
      maxOpenTrades: m(L.discipline.maxOpenTrades, l?.maxOpenTrades),
      maxTradesPerDay: m(L.discipline.maxTradesPerDay, l?.maxTradesPerDay),
    },
  };
}

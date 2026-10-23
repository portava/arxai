// ── Seed runner ─────────────────────────────────────────────────────────────
// Populate the symbol registry, default risk settings, and strategy defaults.
// Idempotent — safe to re-run after schema changes.
import { eq } from "drizzle-orm";
import { db, pool } from "../index";
import { symbolsTable } from "../schema/symbols";
import { strategiesTable } from "../schema/strategies";
import { riskSettingsTable } from "../schema/riskSettings";
import { buildSymbolSeeds } from "./symbolSeeds";
import { buildStrategySeeds, STRATEGY_META } from "./strategySeeds";
import { RISK_MODE_PRESETS } from "./riskModes";

async function seedSymbols() {
  const seeds = buildSymbolSeeds();
  let inserted = 0;
  for (const s of seeds) {
    const existing = await db.select({ id: symbolsTable.id }).from(symbolsTable).where(eq(symbolsTable.symbol, s.symbol)).limit(1);
    if (existing.length === 0) {
      await db.insert(symbolsTable).values(s);
      inserted++;
    }
  }
  console.log(`[seed] symbols: +${inserted} new (of ${seeds.length} total)`);
}

async function seedStrategies() {
  const seeds = buildStrategySeeds();
  let inserted = 0;
  for (const s of seeds) {
    const existing = await db.select({ id: strategiesTable.id }).from(strategiesTable).where(eq(strategiesTable.name, s.name)).limit(1);
    if (existing.length === 0) {
      await db.insert(strategiesTable).values(s);
      inserted++;
    }
  }
  console.log(`[seed] strategies: +${inserted} new (of ${seeds.length} total — ${STRATEGY_META.length} defined)`);
}

async function seedRiskSettings() {
  const existing = await db.select({ id: riskSettingsTable.id }).from(riskSettingsTable).limit(1);
  if (existing.length === 0) {
    const balanced = RISK_MODE_PRESETS.Balanced;
    await db.insert(riskSettingsTable).values({
      riskMode: balanced.riskMode,
      riskPerTradePct: balanced.riskPerTradePct,
      maxDailyLossPct: balanced.maxDailyLossPct,
      maxWeeklyLossPct: balanced.maxWeeklyLossPct,
      maxTradesPerDay: balanced.maxTradesPerDay,
      maxOpenTrades: balanced.maxOpenTrades,
      stopAfterLosingStreak: balanced.stopAfterLosingStreak,
      minConfidenceScore: balanced.minConfidenceScore,
    });
    console.log(`[seed] risk_settings: inserted Balanced default`);
  } else {
    console.log(`[seed] risk_settings: already configured, skipping`);
  }
}

async function main() {
  console.log("[seed] starting…");
  await seedSymbols();
  await seedStrategies();
  await seedRiskSettings();
  console.log("[seed] done.");
  await pool.end();
}

main().catch((err) => {
  console.error("[seed] failed:", err);
  process.exit(1);
});

export { RISK_MODE_PRESETS };

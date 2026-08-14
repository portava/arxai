// Build FF — Settings load/save with safe defaults.
//
// SAFETY: liveTradingAllowed is FORCED to false on every read AND every write.
// paperOnly is FORCED to true. mode is FORCED to "PAPER_ONLY".

import { db, autopilotSettingsTable } from "@workspace/db";
import { desc } from "drizzle-orm";
import type { AutopilotSettings } from "./types.js";

export const DEFAULT_SETTINGS: AutopilotSettings = {
  enabled: false,
  mode: "PAPER_ONLY",
  symbols: ["Volatility 75 Index"],
  timeframes: ["M5"],
  intervalSeconds: 60,
  maxCyclesPerStart: 10,
  maxOpenPaperTrades: 3,
  maxSameSymbolTrades: 1,
  maxDailyPaperLoss: 300,
  minConfidence: 70,
  maxRiskScore: 40,
  minSniperEntryScore: 75,
  cooldownMinutesAfterTrade: 15,
  cooldownMinutesAfterLoss: 30,
  paperOnly: true,
  liveTradingAllowed: false,
};

function forceSafe(s: AutopilotSettings): AutopilotSettings {
  return {
    ...s,
    mode: "PAPER_ONLY",
    paperOnly: true,
    liveTradingAllowed: false,
  };
}

export async function loadSettings(): Promise<AutopilotSettings> {
  const rows = await db.select().from(autopilotSettingsTable)
    .orderBy(desc(autopilotSettingsTable.id)).limit(1);
  if (!rows[0]) return { ...DEFAULT_SETTINGS };
  const r = rows[0];
  return forceSafe({
    enabled: !!r.enabled,
    mode: "PAPER_ONLY",
    symbols: Array.isArray(r.symbols) ? r.symbols as string[] : DEFAULT_SETTINGS.symbols,
    timeframes: Array.isArray(r.timeframes) ? r.timeframes as string[] : DEFAULT_SETTINGS.timeframes,
    intervalSeconds: r.intervalSeconds,
    maxCyclesPerStart: r.maxCyclesPerStart,
    maxOpenPaperTrades: r.maxOpenPaperTrades,
    maxSameSymbolTrades: r.maxSameSymbolTrades,
    maxDailyPaperLoss: r.maxDailyPaperLoss,
    minConfidence: r.minConfidence,
    maxRiskScore: r.maxRiskScore,
    minSniperEntryScore: r.minSniperEntryScore,
    cooldownMinutesAfterTrade: r.cooldownMinutesAfterTrade,
    cooldownMinutesAfterLoss: r.cooldownMinutesAfterLoss,
    paperOnly: true,
    liveTradingAllowed: false,
  });
}

export async function saveSettings(patch: Partial<AutopilotSettings>): Promise<AutopilotSettings> {
  const current = await loadSettings();
  const merged = forceSafe({ ...current, ...patch });
  // Always insert a new row (audit trail). loadSettings reads latest.
  await db.insert(autopilotSettingsTable).values({
    enabled: merged.enabled,
    mode: "PAPER_ONLY",
    symbols: merged.symbols,
    timeframes: merged.timeframes,
    intervalSeconds: merged.intervalSeconds,
    maxCyclesPerStart: merged.maxCyclesPerStart,
    maxOpenPaperTrades: merged.maxOpenPaperTrades,
    maxSameSymbolTrades: merged.maxSameSymbolTrades,
    maxDailyPaperLoss: merged.maxDailyPaperLoss,
    minConfidence: merged.minConfidence,
    maxRiskScore: merged.maxRiskScore,
    minSniperEntryScore: merged.minSniperEntryScore,
    cooldownMinutesAfterTrade: merged.cooldownMinutesAfterTrade,
    cooldownMinutesAfterLoss: merged.cooldownMinutesAfterLoss,
    paperOnly: true,
    liveTradingAllowed: false,
    updatedAt: new Date(),
  });
  return merged;
}

// Hard assertion — called before every cycle. If anyone has flipped these
// in-memory or the DB row is corrupted, REFUSE to run.
export function assertSafe(s: AutopilotSettings): void {
  if (s.liveTradingAllowed !== false)
    throw new Error("Build FF safety violation: liveTradingAllowed must be false");
  if (s.paperOnly !== true)
    throw new Error("Build FF safety violation: paperOnly must be true");
  if (s.mode !== "PAPER_ONLY")
    throw new Error("Build FF safety violation: mode must be PAPER_ONLY");
}

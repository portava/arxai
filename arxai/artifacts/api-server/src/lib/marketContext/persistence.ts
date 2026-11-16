// Phase UX6 — Market context persistence.
//
// Saves the per-symbol snapshot (shared cache) and the per-trade context
// (user-scoped, atomic upsert).

import { db } from "@workspace/db";
import { marketContextSnapshotsTable, tradeMarketContextTable } from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";
import type { MarketContext } from "./contextBuilder.js";
import type { ClassificationResult } from "./classifier.js";
import type { KeyLevels } from "./keyLevels.js";
import type { TradeContextResult } from "./tradeContext.js";

export async function persistSymbolSnapshot(ctx: MarketContext): Promise<void> {
  const primary = (["M15", "M5", "H1"] as const).map((t) => ctx.timeframes[t]).find((t) => t.available) ?? ctx.timeframes.M15;
  await db.insert(marketContextSnapshotsTable).values({
    symbol: ctx.symbol, timeframe: primary.timeframe,
    currentPrice: ctx.currentPrice, bid: ctx.bid, ask: ctx.ask, spread: ctx.spread,
    trendDirection: primary.trendDirection,
    trendStrengthScore: primary.trendStrengthScore,
    atr: primary.atr,
    volatilityScore: null,
    swingHigh: primary.swingHigh, swingLow: primary.swingLow,
    breakoutLevel: primary.rangeHigh,
    supportLevels: primary.supportLevels as unknown as Record<string, unknown>,
    resistanceLevels: primary.resistanceLevels as unknown as Record<string, unknown>,
    dataQuality: ctx.dataQuality as unknown as Record<string, unknown>,
    source: ctx.source,
  } as never);
}

export interface PersistTradeContextInput {
  userId: number;
  tradeKey: string;
  routingMode: string;
  symbol: string;
  side: "BUY" | "SELL";
  ctx: MarketContext;
  classification: ClassificationResult;
  keyLevels: KeyLevels;
  tradeCtx: TradeContextResult;
}

export async function upsertTradeMarketContext(input: PersistTradeContextInput) {
  const { userId, tradeKey, routingMode, symbol, side, ctx, classification, keyLevels, tradeCtx } = input;
  const row = {
    userId, tradeKey, routingMode, symbol, side,
    classificationLabel: classification.label,
    continuationScore: classification.scores.continuationScore,
    pullbackScore: classification.scores.pullbackScore,
    retracementScore: classification.scores.retracementScore,
    reversalRiskScore: classification.scores.reversalRiskScore,
    fakeoutRiskScore: classification.scores.fakeoutRiskScore,
    liquiditySweepScore: classification.scores.liquiditySweepScore,
    chopRiskScore: classification.scores.chopRiskScore,
    breakoutStrengthScore: classification.scores.breakoutStrengthScore,
    trendStrengthScore: classification.scores.trendStrengthScore,
    momentumStrengthScore: classification.scores.momentumStrengthScore,
    volatilityRiskScore: classification.scores.volatilityRiskScore,
    trendAlignment: tradeCtx.trendAlignment,
    tradeLabel: tradeCtx.tradeLabel,
    keyLevelToWatch: keyLevels.keyLevelToWatch,
    invalidationLevel: keyLevels.invalidationLevel,
    continuationLevel: keyLevels.continuationLevel,
    nearestSupport: keyLevels.nearestSupport,
    nearestResistance: keyLevels.nearestResistance,
    swingHigh: keyLevels.swingHigh,
    swingLow: keyLevels.swingLow,
    breakoutLevel: keyLevels.breakoutLevel,
    explanation: classification.explanation,
    bullishScenario: tradeCtx.bullishScenario,
    bearishScenario: tradeCtx.bearishScenario,
    dataQuality: ctx.dataQuality as unknown as Record<string, unknown>,
    source: ctx.source,
    createdAt: new Date(),
  };
  const [up] = await db.insert(tradeMarketContextTable).values(row as never)
    .onConflictDoUpdate({
      target: [tradeMarketContextTable.userId, tradeMarketContextTable.tradeKey],
      set: { ...row, createdAt: new Date() } as never,
    })
    .returning();
  return up;
}

// Load the most recent stored snapshot for (user, tradeKey) so the alert
// engine can compare prior → current and only emit on real transitions.
// Returns null when no prior row exists yet.
export async function loadPriorTradeMarketContext(
  userId: number,
  tradeKey: string,
): Promise<{ classificationLabel: string | null; fakeoutRiskScore: number | null; trendAlignment: string | null } | null> {
  const [row] = await db.select({
    classificationLabel: tradeMarketContextTable.classificationLabel,
    fakeoutRiskScore: tradeMarketContextTable.fakeoutRiskScore,
    trendAlignment: tradeMarketContextTable.trendAlignment,
  }).from(tradeMarketContextTable)
    .where(and(
      eq(tradeMarketContextTable.userId, userId),
      eq(tradeMarketContextTable.tradeKey, tradeKey),
    ))
    .limit(1);
  return row ?? null;
}

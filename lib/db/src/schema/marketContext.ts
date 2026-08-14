import {
  pgTable, serial, integer, text, real, timestamp, jsonb, index, uniqueIndex,
} from "drizzle-orm/pg-core";

// Phase UX6 — Market Context Engine.
//
// SAFETY:
//   * market_context_snapshots is a per-symbol cache of provider-backed
//     multi-timeframe context. Never user-private data; never contains
//     secrets. Reads can be shared across users.
//   * trade_market_context is user-scoped. Every row carries user_id and
//     trade_key; reads MUST filter by req.authUser.id and ownership of the
//     trade is re-checked via resolveTrade().
//   * No row triggers an order. Engine is decision support only.
//   * Missing inputs → null scores + data_quality=insufficient. No fabrication.

export const marketContextSnapshotsTable = pgTable("market_context_snapshots", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull(),
  timeframe: text("timeframe").notNull(),          // M1|M5|M15|M30|H1|H4|D1
  currentPrice: real("current_price"),
  bid: real("bid"),
  ask: real("ask"),
  spread: real("spread"),
  trendDirection: text("trend_direction"),          // UP | DOWN | FLAT | UNKNOWN
  trendStrengthScore: real("trend_strength_score"), // 0..100
  atr: real("atr"),
  volatilityScore: real("volatility_score"),        // 0..100
  swingHigh: real("swing_high"),
  swingLow: real("swing_low"),
  breakoutLevel: real("breakout_level"),
  supportLevels: jsonb("support_levels"),           // number[]
  resistanceLevels: jsonb("resistance_levels"),     // number[]
  dataQuality: jsonb("data_quality"),               // { hasCandles, missing[] }
  source: text("source"),                           // provider name
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  symbolTfIdx: index("market_context_symbol_tf_idx").on(t.symbol, t.timeframe, t.createdAt),
}));

export const tradeMarketContextTable = pgTable("trade_market_context", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  tradeKey: text("trade_key").notNull(),
  routingMode: text("routing_mode").notNull(),
  symbol: text("symbol").notNull(),
  side: text("side").notNull(),
  classificationLabel: text("classification_label"),
  // 11 scores 0..100 (nullable = insufficient data)
  continuationScore: real("continuation_score"),
  pullbackScore: real("pullback_score"),
  retracementScore: real("retracement_score"),
  reversalRiskScore: real("reversal_risk_score"),
  fakeoutRiskScore: real("fakeout_risk_score"),
  liquiditySweepScore: real("liquidity_sweep_score"),
  chopRiskScore: real("chop_risk_score"),
  breakoutStrengthScore: real("breakout_strength_score"),
  trendStrengthScore: real("trend_strength_score"),
  momentumStrengthScore: real("momentum_strength_score"),
  volatilityRiskScore: real("volatility_risk_score"),
  trendAlignment: text("trend_alignment"),          // ALIGNED | FIGHTING | NEUTRAL | UNKNOWN
  tradeLabel: text("trade_label"),                  // "Trade aligned with trend" etc.
  keyLevelToWatch: real("key_level_to_watch"),
  invalidationLevel: real("invalidation_level"),
  continuationLevel: real("continuation_level"),
  nearestSupport: real("nearest_support"),
  nearestResistance: real("nearest_resistance"),
  swingHigh: real("swing_high"),
  swingLow: real("swing_low"),
  breakoutLevel: real("breakout_level"),
  explanation: text("explanation"),
  bullishScenario: text("bullish_scenario"),
  bearishScenario: text("bearish_scenario"),
  dataQuality: jsonb("data_quality"),
  source: text("source"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  userTradeIdx: index("trade_market_ctx_user_trade_idx").on(t.userId, t.tradeKey, t.createdAt),
  userTradeLatestUnique: uniqueIndex("trade_market_ctx_user_trade_unique").on(t.userId, t.tradeKey),
}));

export type MarketContextSnapshot = typeof marketContextSnapshotsTable.$inferSelect;
export type TradeMarketContext = typeof tradeMarketContextTable.$inferSelect;

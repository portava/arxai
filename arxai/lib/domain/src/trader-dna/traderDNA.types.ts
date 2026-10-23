// ═══════════════════════════════════════════════════════════════════════════
// Trader DNA — TYPES (Phase 5 augmentation)
//
// Re-exports the existing TraderProfile types for ergonomics + adds the
// new composed types Phase 5 introduces:
//   • TradeWithContext     — Trade enriched with strategyId/session
//   • PersonalEdgeBucket   — (symbol, session, strategy, hourOfDay) cell
//   • PersonalEdgeMap      — full bucket grid + best/worst pickers
//   • SymbolStats          — per-symbol expectancy
//   • StrategyStats        — per-strategy expectancy (per trader)
//   • TraderRiskScore      — composed scalar [0..1] + level + recommendation
//   • PermissionLevel      — FULL / REDUCED / MICRO / COOLDOWN / LOCKDOWN
//
// All trader DNA outputs are advisory.
// ═══════════════════════════════════════════════════════════════════════════

import { z } from "zod/v4";
import { TradeSchema } from "../trade/trade.types";
import { DnaSeveritySchema } from "./traderProfile.types";

export * from "./traderProfile.types";

export const SessionEnumSchema = z.enum([
  "ASIA", "LONDON", "NEW_YORK", "OVERLAP_LONDON_NY", "OFF_HOURS",
]);
export type SessionEnum = z.infer<typeof SessionEnumSchema>;

export const TradeWithContextSchema = TradeSchema.extend({
  strategyId: z.string().min(1).default("UNKNOWN"),
  session: SessionEnumSchema.optional(),    // if absent, derived from openedAt
});
export type TradeWithContext = z.infer<typeof TradeWithContextSchema>;

export const PermissionLevelSchema = z.enum([
  "FULL", "REDUCED", "MICRO", "COOLDOWN", "LOCKDOWN",
]);
export type PermissionLevel = z.infer<typeof PermissionLevelSchema>;

export const TraderRecommendedActionSchema = z.enum([
  "EXECUTE", "REDUCE_SIZE", "WAIT", "COOLDOWN", "RECOVERY_MODE", "HARD_BLOCK",
]);
export type TraderRecommendedAction = z.infer<typeof TraderRecommendedActionSchema>;

export const TraderRiskScoreSchema = z.object({
  score01:        z.number().min(0).max(1),
  level:          DnaSeveritySchema,
  components: z.object({
    revenge01:     z.number().min(0).max(1),
    overtrade01:   z.number().min(0).max(1),
    behavior01:    z.number().min(0).max(1),
    edgeWeakness01: z.number().min(0).max(1),
  }),
  permission:     PermissionLevelSchema,
  recommendedAction: TraderRecommendedActionSchema,
  reasons:  z.array(z.string()),
  warnings: z.array(z.string()),
});
export type TraderRiskScore = z.infer<typeof TraderRiskScoreSchema>;

export const PersonalEdgeBucketSchema = z.object({
  symbol: z.string(),
  session: SessionEnumSchema,
  strategyId: z.string(),
  hourOfDay: z.number().int().min(0).max(23),
  sample: z.number().int().nonnegative(),
  winRate01: z.number().min(0).max(1),
  expectancyR: z.number(),
  netPnl: z.number(),
  edgeScore01: z.number().min(0).max(1),     // sample-weighted normalized
});
export type PersonalEdgeBucket = z.infer<typeof PersonalEdgeBucketSchema>;

export const PersonalEdgeMapSchema = z.object({
  buckets: z.array(PersonalEdgeBucketSchema),
  best:  z.array(PersonalEdgeBucketSchema),    // top-3 by edgeScore01
  worst: z.array(PersonalEdgeBucketSchema),    // bottom-3
  totalSample: z.number().int().nonnegative(),
  personalEdgeScore01: z.number().min(0).max(1), // sample-weighted mean of edgeScore01
});
export type PersonalEdgeMap = z.infer<typeof PersonalEdgeMapSchema>;

export const SymbolStatsSchema = z.object({
  symbol: z.string(),
  sample: z.number().int().nonnegative(),
  winRate01: z.number().min(0).max(1),
  expectancyR: z.number(),
  netPnl: z.number(),
  profitFactor: z.number(),
});
export type SymbolStats = z.infer<typeof SymbolStatsSchema>;

export const StrategyStatsSchema = z.object({
  strategyId: z.string(),
  sample: z.number().int().nonnegative(),
  winRate01: z.number().min(0).max(1),
  expectancyR: z.number(),
  netPnl: z.number(),
  profitFactor: z.number(),
});
export type StrategyStats = z.infer<typeof StrategyStatsSchema>;

import { z } from "zod/v4";

export const RiskModeSchema = z.enum(["Conservative", "Balanced", "Aggressive", "Custom"]);
export type RiskMode = z.infer<typeof RiskModeSchema>;

export const RiskLimitsSchema = z.object({
  riskPerTradePct: z.number().min(0.01).max(10),
  maxDailyLossPct: z.number().min(0.1).max(50),
  maxWeeklyLossPct: z.number().min(0.1).max(50),
  maxTradesPerDay: z.number().int().min(1).max(100),
  maxOpenTrades: z.number().int().min(1).max(50),
  stopAfterLosingStreak: z.number().int().min(1).max(20),
  minConfidenceScore: z.number().min(0).max(100),
});
export type RiskLimits = z.infer<typeof RiskLimitsSchema>;

export const RiskProfileSchema = z.object({
  mode: RiskModeSchema,
  limits: RiskLimitsSchema,
  liveLocked: z.boolean().default(true),
});
export type RiskProfile = z.infer<typeof RiskProfileSchema>;

export const RiskCheckResultSchema = z.object({
  allowed: z.boolean(),
  reasons: z.array(z.string()),
  warnings: z.array(z.string()),
});
export type RiskCheckResult = z.infer<typeof RiskCheckResultSchema>;

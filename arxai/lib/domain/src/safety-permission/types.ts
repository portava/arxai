import { z } from "zod/v4";

export const PermissionStatusSchema = z.enum([
  "CLEAR",
  "CAUTION",
  "LOCKED",
  "LIVE_TRADING_DISABLED",
]);
export type PermissionStatus = z.infer<typeof PermissionStatusSchema>;

export const RiskLevelSchema = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const PermissionReasonSchema = z.object({
  code: z.string(),
  severity: z.enum(["INFO", "WARN", "BLOCK"]),
  message: z.string(),
});
export type PermissionReason = z.infer<typeof PermissionReasonSchema>;

export const ActiveLockSummarySchema = z.object({
  lockType: z.string(),
  reason: z.string(),
  startTimeIso: z.string(),
  endTimeIso: z.string().nullable(),
  remainingMs: z.number().nullable(),
  overrideAllowed: z.boolean(),
});
export type ActiveLockSummary = z.infer<typeof ActiveLockSummarySchema>;

export const PermissionVerdictSchema = z.object({
  status: PermissionStatusSchema,
  riskLevel: RiskLevelSchema,
  /** Always false in MVP — system is OBSERVE_ONLY + PAPER_TRADING only.
   *  Returned for future-state surfaces; UI must respect this flag. */
  canPlaceTrades: z.literal(false),
  liveTradingDisabled: z.boolean(),
  activeLockType: z.string().nullable(),
  reasons: z.array(PermissionReasonSchema),
  blockers: z.array(z.string()),
  warnings: z.array(z.string()),
  activeLocks: z.array(ActiveLockSummarySchema),
  evaluatedAtIso: z.string(),
});
export type PermissionVerdict = z.infer<typeof PermissionVerdictSchema>;

export const PermissionInputsSchema = z.object({
  // From safetyCore.getStatus()
  operationalMode: z.string(),
  killSwitchEngaged: z.boolean(),
  mt5LinkHealth: z.enum(["OK", "DEGRADED", "DOWN"]),
  liveAllowed: z.boolean(),

  // From risk_settings
  maxDailyLossPct: z.number(),
  maxTradesPerDay: z.number().int(),
  stopAfterLosingStreak: z.number().int(),
  maxLotSize: z.number(),
  cooldownAfterLossMinutes: z.number().int(),
  liveLocked: z.boolean(),

  // Computed from today's trades
  todaysTradesCount: z.number().int().nonnegative(),
  todaysLossPct: z.number(), // negative number = loss; positive = profit
  consecutiveLosses: z.number().int().nonnegative(),

  // From latest signal/market scan (optional — may be absent)
  marketCondition: z.string().optional(), // "NO_TRADE" if disallowed
  spreadWide: z.boolean().optional(),
  liquidityLow: z.boolean().optional(),

  // From trader-dna detectors (optional)
  revengeTrading: z.boolean().optional(),
  overtrading: z.boolean().optional(),

  // From routes/permission caller — already-fetched active locks
  activeLocks: z.array(ActiveLockSummarySchema),

  // Misc
  brokerCredentialsConfigured: z.boolean(),
});
export type PermissionInputs = z.infer<typeof PermissionInputsSchema>;

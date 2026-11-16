import { z } from "zod/v4";
import type { Trade } from "../trade/trade.types";
import type { RiskLimits } from "./riskProfile.types";
import type { Mt5Account } from "../broker/mt5.types";
import type { VolatilityState } from "../market/volatility.engine";
import type { Session } from "../market/session.engine";

// ── Gate identifiers — match the spec'd rule list ──────────────────────────
export const RiskGateNameSchema = z.enum([
  "MAX_DAILY_LOSS",
  "MAX_OPEN_TRADES",
  "MAX_LOT_SIZE",
  "MAX_EXPOSURE_PER_SYMBOL",
  "SPREAD_CHECK",
  "VOLATILITY_CHECK",
  "NEWS_LOCKOUT",
  "DRAWDOWN_CHECK",
  "SESSION_RULE",
  "MANUAL_OVERRIDE",
]);
export type RiskGateName = z.infer<typeof RiskGateNameSchema>;

// ── Per-gate verdict ────────────────────────────────────────────────────────
export const RiskGateStatusSchema = z.enum(["ALLOW", "WARN", "BLOCK"]);
export type RiskGateStatus = z.infer<typeof RiskGateStatusSchema>;

export interface RiskGateResult {
  gate: RiskGateName;
  status: RiskGateStatus;
  reason: string;
  value?: number;          // observed value for the gate (e.g. spread in pips)
  threshold?: number;      // configured threshold
}

// ── News & overrides — runtime inputs not in RiskLimits ────────────────────
export interface NewsWindow {
  symbol: string;          // affected symbol or "*" for global
  from: string;            // ISO
  to: string;              // ISO
  severity: "LOW" | "MEDIUM" | "HIGH";
  headline: string;
}

export const ManualOverrideSchema = z.object({
  state: z.enum(["NONE", "FORCE_ALLOW", "FORCE_BLOCK"]),
  reason: z.string().nullable(),
  setBy: z.string().nullable(),
  setAt: z.string().nullable(),     // ISO
  expiresAt: z.string().nullable(), // ISO
});
export type ManualOverride = z.infer<typeof ManualOverrideSchema>;

// ── Extended gate config — composes RiskLimits with the runtime extras ─────
export const RiskGateConfigSchema = z.object({
  maxLotSize: z.number().positive(),
  maxExposurePerSymbol: z.number().positive(),     // net lots
  maxSpreadPips: z.number().positive(),
  maxVolatility: z.enum(["CALM", "NORMAL", "ELEVATED", "EXTREME"]),
  allowedSessions: z.array(z.enum(["ASIA", "LONDON", "NEW_YORK", "OVERLAP_LONDON_NY", "OFF_HOURS"])),
  newsLockoutMinutesBefore: z.number().int().nonnegative().default(15),
  newsLockoutMinutesAfter: z.number().int().nonnegative().default(15),
});
export type RiskGateConfig = z.infer<typeof RiskGateConfigSchema>;

// ── Inputs the gate registry consumes (built once per evaluation) ──────────
export interface RiskGateContext {
  symbol: string;
  proposedLotSize: number;
  proposedDirection: "BUY" | "SELL";
  account: Mt5Account | null;
  startingDailyBalance: number;
  startingWeeklyBalance: number;
  losingStreak: number;
  openTrades: Trade[];
  currentSpreadPips: number | null;
  currentVolatility: VolatilityState | null;
  currentSession: Session;
  newsWindows: NewsWindow[];
  override: ManualOverride;
  limits: RiskLimits;
  config: RiskGateConfig;
  now?: Date;
}

// ── Aggregated evaluation result ────────────────────────────────────────────
export interface RiskGateEvaluation {
  allowed: boolean;
  results: RiskGateResult[];
  blocking: RiskGateResult[];
  warnings: RiskGateResult[];
  override: "NONE" | "FORCE_ALLOW" | "FORCE_BLOCK";
}

// ── Gate function signature ────────────────────────────────────────────────
export type RiskGate = (ctx: RiskGateContext) => RiskGateResult;

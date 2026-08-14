import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// Phase 1 — Risk Governor sub-guard rules.
//
// These are focused single-concern guards that the master `evaluateRiskGovernor`
// composes from. Each sub-guard returns the same `GuardVerdict` shape so the
// Control Tower / Decision Router can run them uniformly and the UI can
// render a row per guard.
//
// Hard rules:
//   • Every guard fails CLOSED on missing data (matches the master engine's
//     FAIL_CLOSED_ON_MISSING_DATA convention).
//   • A guard never authorizes — `passed:true` only means "this guard has no
//     objection". The Control Tower retains final authority.
//   • All thresholds are inputs; engines hold no policy.
// ═══════════════════════════════════════════════════════════════════════════

export const GuardKindSchema = z.enum([
  "HARD_BLOCK",        // composite — at least one mandatory rule failed
  "DRAWDOWN",          // rolling drawdown crossed the cap
  "EXPOSURE",          // open-trade count or % exposure crossed the cap
  "MAX_LOSS",          // per-trade or daily realized loss crossed the cap
]);
export type GuardKind = z.infer<typeof GuardKindSchema>;

export interface GuardVerdict {
  kind: GuardKind;
  passed: boolean;            // true = no objection from this guard
  reasons: string[];          // human-readable per failure (always present, even when passed)
  observed: Record<string, number | string | null>;
  thresholds: Record<string, number | string>;
  dataMissing: boolean;
  evaluatedAtIso: string;
}

// ── Drawdown guard inputs ────────────────────────────────────────────────
export const DrawdownGuardInputSchema = z.object({
  currentDrawdownPct: z.number().min(0).max(100).nullable(),
  maxDrawdownPct: z.number().positive().max(100),
  // Optional rolling window stats — when present, also enforced.
  rollingPeakEquity: z.number().positive().nullable().default(null),
  currentEquity: z.number().positive().nullable().default(null),
  now: z.date().optional(),
});
export type DrawdownGuardInput = z.infer<typeof DrawdownGuardInputSchema>;

// ── Exposure guard inputs ────────────────────────────────────────────────
export const ExposureGuardInputSchema = z.object({
  openTradeCount: z.number().int().min(0),
  maxOpenTrades: z.number().int().positive(),
  totalExposurePct: z.number().min(0).nullable(),
  maxExposurePct: z.number().positive().max(1000),
  perSymbolCount: z.array(z.object({
    symbol: z.string().min(1),
    count: z.number().int().min(0),
  })).max(200).default([]),
  maxPerSymbol: z.number().int().positive().default(5),
  now: z.date().optional(),
});
export type ExposureGuardInput = z.infer<typeof ExposureGuardInputSchema>;

// ── Max-loss guard inputs ────────────────────────────────────────────────
export const MaxLossGuardInputSchema = z.object({
  realizedDailyLossPct: z.number().min(0).max(100).nullable(),
  maxDailyLossPct: z.number().positive().max(100),
  perTradeLossPct: z.number().min(0).max(100).nullable().default(null),
  maxPerTradeLossPct: z.number().positive().max(100).default(2),
  consecutiveLossCount: z.number().int().min(0).default(0),
  maxConsecutiveLosses: z.number().int().positive().default(5),
  now: z.date().optional(),
});
export type MaxLossGuardInput = z.infer<typeof MaxLossGuardInputSchema>;

// ── Hard-block composite inputs ──────────────────────────────────────────
export const HardBlockInputSchema = z.object({
  drawdown: DrawdownGuardInputSchema,
  exposure: ExposureGuardInputSchema,
  maxLoss: MaxLossGuardInputSchema,
  now: z.date().optional(),
});
export type HardBlockInput = z.infer<typeof HardBlockInputSchema>;

export interface HardBlockVerdict extends GuardVerdict {
  kind: "HARD_BLOCK";
  subVerdicts: GuardVerdict[];   // always [drawdown, exposure, maxLoss] in declaration order
  blockingKinds: GuardKind[];    // subset of subVerdicts where passed=false
}

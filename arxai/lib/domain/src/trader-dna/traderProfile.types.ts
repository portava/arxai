import { z } from "zod/v4";
import type { Trade } from "../trade/trade.types";
import type { Session } from "../market/session.engine";

// ── Trait taxonomy — stable personality descriptors ────────────────────────
export const TraderTraitSchema = z.enum([
  "AGGRESSIVE",
  "CONSERVATIVE",
  "PATIENT",
  "IMPATIENT",
  "DISCIPLINED",
  "EMOTIONAL",
  "ANALYTICAL",
  "INTUITIVE",
]);
export type TraderTrait = z.infer<typeof TraderTraitSchema>;

// ── Behavior patterns — observed, evidence-based ───────────────────────────
export const BehaviorPatternSchema = z.enum([
  "REVENGE_TRADING",       // re-enters quickly after a loss with bigger size
  "OVERTRADING",           // trades-per-day above baseline
  "FOMO_CHASING",          // entries chase price after big moves
  "HESITATION",            // delays past optimal entry / misses signals
  "EARLY_EXIT",            // closes profitable trades before TP frequently
  "RUNNER_CUTTING",        // cuts winners short, lets losers run
  "OVERSIZED_BETS",        // lot sizes above baseline
  "FILTER_IGNORING",       // bypasses risk gates / flags via override
]);
export type BehaviorPattern = z.infer<typeof BehaviorPatternSchema>;

// ── Severity scale used across all trader-dna engines ──────────────────────
export const DnaSeveritySchema = z.enum(["NONE", "LOW", "MEDIUM", "HIGH", "CRITICAL"]);
export type DnaSeverity = z.infer<typeof DnaSeveritySchema>;

// ── Trader profile — operator's identity + observed baselines ──────────────
export const TraderProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  traits: z.array(TraderTraitSchema),

  // Personal baselines (rolling) — used by detectors as the "normal" reference
  baselineTradesPerDay: z.number().nonnegative(),
  baselineLotSize: z.number().nonnegative(),
  baselineWinRate: z.number().min(0).max(1),
  baselineAvgRMultiple: z.number(),

  // Currently observed patterns + their confidence (0..100)
  observedPatterns: z.array(z.object({
    pattern: BehaviorPatternSchema,
    confidence: z.number().min(0).max(100),
    severity: DnaSeveritySchema,
    evidence: z.array(z.string()),
    detectedAt: z.string(),     // ISO
  })),

  // Per-session preferences derived from sessionPerformance.engine
  preferredSessions: z.array(z.enum(["ASIA", "LONDON", "NEW_YORK", "OVERLAP_LONDON_NY", "OFF_HOURS"])),
  avoidedSessions:  z.array(z.enum(["ASIA", "LONDON", "NEW_YORK", "OVERLAP_LONDON_NY", "OFF_HOURS"])),

  lastUpdatedAt: z.string(),
});
export type TraderProfile = z.infer<typeof TraderProfileSchema>;

// ── A bounded trade history window the engines analyze ─────────────────────
// Engines never read the live DB — they take a window-of-trades input so they
// stay pure and trivially testable.
export interface TraderHistoryWindow {
  trades: Trade[];                 // ordered oldest → newest, already closed
  windowStart: Date;
  windowEnd: Date;
}

// ── Standard report shape every engine in this subdomain returns ───────────
export interface DnaReport {
  detected: boolean;
  severity: DnaSeverity;
  confidence: number;              // 0..100
  evidence: string[];
  recommendation: string | null;
}

// ── Per-session aggregate (sessionPerformance.engine output unit) ──────────
export interface SessionPerformance {
  session: Session;
  tradeCount: number;
  winRate: number;                 // 0..1
  avgRMultiple: number;
  netPnL: number;
  profitFactor: number;            // grossWin / grossLoss; Infinity if no losses
}

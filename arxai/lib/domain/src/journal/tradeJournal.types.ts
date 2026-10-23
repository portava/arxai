import { z } from "zod/v4";
import type { Candle } from "../market/marketRegime.engine";
import type { VolatilityState } from "../market/volatility.engine";
import type { Session } from "../market/session.engine";
import type { TradeHealthState } from "../trade/tradeHealth.engine";
import type { Trade, TradeStatus, TradeDirection } from "../trade/trade.types";

// ── Per-snapshot health record ─────────────────────────────────────────────
// Captured each time the trade's health is re-evaluated (typically once per
// management tick). Lets the journal render a health timeline.
export const HealthChangeSchema = z.object({
  at: z.union([z.date(), z.string()]),     // ISO or Date
  score: z.number().min(0).max(100),
  state: z.enum(["HEALTHY", "AT_RISK", "CRITICAL", "WINNING", "RUNNER"]),
  rMultiple: z.number(),
  price: z.number(),
  note: z.string().optional(),
});
export type HealthChange = z.infer<typeof HealthChangeSchema>;

// ── Final result captured at CLOSED → REVIEWED ─────────────────────────────
export const TradeFinalResultSchema = z.object({
  status: z.enum(["CLOSED_WIN", "CLOSED_LOSS", "CLOSED_BREAKEVEN", "CANCELLED", "EXPIRED"]),
  pnl: z.number(),
  pnlPct: z.number(),
  rMultiple: z.number(),
  durationSeconds: z.number().int().nonnegative(),
  exitReason: z.string(),                  // mirrors strategies.ExitDecision.exitType
});
export type TradeFinalResult = z.infer<typeof TradeFinalResultSchema>;

// ── Candle structure (re-exported via Zod for serialization) ───────────────
export const JournalCandleSchema = z.object({
  time: z.number().int(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number().optional(),
});

// ── The full journal record — the 10 fields, in order ──────────────────────
// One per trade, written after CLOSED, sealed at REVIEWED.
export const TradeJournalEntrySchema = z.object({
  tradeId: z.union([z.string(), z.number()]),
  symbol: z.string(),
  direction: z.enum(["BUY", "SELL"]),
  strategyName: z.string(),
  strategyVersion: z.string(),

  // 1. candles before entry — context window
  candlesBeforeEntry: z.array(JournalCandleSchema),
  // 2. entry candle
  entryCandle: JournalCandleSchema,
  // 3. exit candle (null while open)
  exitCandle: JournalCandleSchema.nullable(),

  // 4. AI notes (from the DECIDE stage at entry time)
  aiNotes: z.array(z.string()),

  // 5. spread (pips) at entry
  spreadAtEntry: z.number().nullable(),
  // 6. session at entry
  sessionAtEntry: z.enum(["ASIA", "LONDON", "NEW_YORK", "OVERLAP_LONDON_NY", "OFF_HOURS"]),
  // 7. volatility state at entry
  volatilityAtEntry: z.enum(["CALM", "NORMAL", "ELEVATED", "EXTREME"]),

  // 8. risk score from the APPROVE stage (0..100, higher = safer)
  riskScore: z.number().min(0).max(100),
  riskGateBreakdown: z.array(z.object({
    gate: z.string(),
    status: z.enum(["ALLOW", "WARN", "BLOCK"]),
    reason: z.string(),
  })),

  // 9. trade health changes — chronological
  healthChanges: z.array(HealthChangeSchema),

  // 10. final result — present once closed
  finalResult: TradeFinalResultSchema.nullable(),

  // Provenance
  createdAt: z.union([z.date(), z.string()]),
  sealedAt: z.union([z.date(), z.string()]).nullable(),   // set when phase → REVIEWED
});
export type TradeJournalEntry = z.infer<typeof TradeJournalEntrySchema>;

// ── Inputs for building / updating a journal entry ─────────────────────────

export interface JournalSeed {
  trade: Trade;
  strategyName: string;
  strategyVersion: string;
  candlesBeforeEntry: Candle[];
  entryCandle: Candle;
  aiNotes: string[];
  spreadAtEntry: number | null;
  sessionAtEntry: Session;
  volatilityAtEntry: VolatilityState;
  riskScore: number;
  riskGateBreakdown: Array<{ gate: string; status: "ALLOW" | "WARN" | "BLOCK"; reason: string }>;
  now?: Date;
}

export interface JournalCloseInput {
  exitCandle: Candle;
  finalStatus: Extract<TradeStatus, "CLOSED_WIN" | "CLOSED_LOSS" | "CLOSED_BREAKEVEN" | "CANCELLED" | "EXPIRED">;
  pnl: number;
  pnlPct: number;
  rMultiple: number;
  exitReason: string;
  closedAt: Date;
}

export interface HealthChangeInput {
  at: Date;
  score: number;
  state: TradeHealthState;
  rMultiple: number;
  price: number;
  note?: string;
}

// Re-export common type aliases for downstream consumers
export type { TradeDirection };

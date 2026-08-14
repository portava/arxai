// Task #199 — Outcome Learning & Admin Quality: admin-tunable Ruby thresholds.
//
// SAFETY / SCOPE:
//   - These thresholds tune how Ruby's OUTCOME LEARNING classifies signals
//     (late entry, confidence/edge floors, news lockout, spread/slippage caps,
//     R:R floor, evidence-move/expiry). They are ADVISORY/LEARNING knobs only:
//     they NEVER feed the 16-gate live pipeline, the kill switch, or any broker
//     dispatch surface. Changing one cannot place, modify, or block a trade.
//   - Single-row config (id is always 1 in practice). Every change is written
//     through an audited admin route (admin_action_audit_log, fail-closed).

import {
  pgTable, serial, integer, real, timestamp, text,
} from "drizzle-orm/pg-core";

export const rubyQualityThresholdsTable = pgTable("ruby_quality_thresholds", {
  id:                  serial("id").primaryKey(),

  lateEntrySeconds:    integer("late_entry_seconds").notNull().default(120),  // entry later than this past signal = LATE
  minConfidence:       real("min_confidence").notNull().default(60),          // 0-100
  minEdge:             real("min_edge").notNull().default(50),                // 0-100
  newsLockoutMinutes:  integer("news_lockout_minutes").notNull().default(30), // minutes around high-impact news
  maxSpread:           real("max_spread").notNull().default(2.5),             // spread cap
  maxSlippage:         real("max_slippage").notNull().default(1.5),           // slippage cap
  minRiskReward:       real("min_risk_reward").notNull().default(1.5),        // R:R floor
  strongMovePct:       real("strong_move_pct").notNull().default(0.4),        // candle-only decisive-move floor
  breakevenR:          real("breakeven_r").notNull().default(0.25),           // |R| <= this is breakeven
  evidenceExpiryMinutes: integer("evidence_expiry_minutes").notNull().default(240), // age past which a no-move no-trade can be judged CORRECT

  updatedByAdminId:    integer("updated_by_admin_id"),
  updatedReason:       text("updated_reason"),
  updatedAt:           timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt:           timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type RubyQualityThresholdsRow = typeof rubyQualityThresholdsTable.$inferSelect;
export type RubyQualityThresholdsInsert = typeof rubyQualityThresholdsTable.$inferInsert;

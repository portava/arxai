import { pgTable, serial, integer, text, real, timestamp, index } from "drizzle-orm/pg-core";

// (R) Build R — Prop Firm Challenge Mode (simulated).
// Rides on top of Build Q (paper_accounts/paper_orders). Never references
// live trades. Status drives a state-machine: ACTIVE → PASSED|FAILED|CANCELED;
// PAUSED is reversible.

export const propChallengesTable = pgTable("prop_challenges", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"),
  paperAccountId: integer("paper_account_id").notNull(), // ← Build Q link
  challengeName: text("challenge_name").notNull().default("Practice Challenge"),
  startingBalance: real("starting_balance").notNull().default(10_000),
  // Rules (percentages stored as 0..1 floats; "5%" → 0.05).
  profitTarget: real("profit_target").notNull().default(0.10),
  maxDailyLoss: real("max_daily_loss").notNull().default(0.05),
  maxTotalDrawdown: real("max_total_drawdown").notNull().default(0.10),
  minTradingDays: integer("min_trading_days").notNull().default(5),
  maxTradingDays: integer("max_trading_days").notNull().default(30),
  consistencyRulePercent: real("consistency_rule_percent").notNull().default(0.40), // any single day ≤ 40% of total profit
  // ── Phase 27-B extended rules (safe defaults: disabled / permissive). ──
  // User-entered; never presented as official prop-firm rules unless verified.
  trailingDrawdownEnabled: integer("trailing_drawdown_enabled").notNull().default(0), // 0|1
  trailingDrawdownAmount: real("trailing_drawdown_amount").notNull().default(0.05),   // 0..1 of peak
  trailingDrawdownType: text("trailing_drawdown_type").notNull().default("STATIC"),   // STATIC | TRAILING
  // Phase 27-B defaults are PERMISSIVE (effectively unlimited) so legacy rows
  // never get retro-enforced. Per-user opt-in via PATCH /prop-challenges/:id/rules.
  maxRiskPerTrade: real("max_risk_per_trade").notNull().default(1.0),                 // 0..1 of day-start balance; 1.0 = no limit
  maxOpenTrades: integer("max_open_trades").notNull().default(100),                   // 100 = effectively unlimited
  maxPendingOrders: integer("max_pending_orders").notNull().default(100),             // 100 = effectively unlimited
  maxPositionSize: real("max_position_size").notNull().default(100),                  // lots; 100 = effectively unlimited
  newsTradingAllowed: integer("news_trading_allowed").notNull().default(1),           // 0|1
  weekendHoldingAllowed: integer("weekend_holding_allowed").notNull().default(1),     // 0|1
  overnightHoldingAllowed: integer("overnight_holding_allowed").notNull().default(1), // 0|1
  strictGuardrailsEnabled: integer("strict_guardrails_enabled").notNull().default(0), // 0|1 — BLOCK paper actions on HARD violations
  // ACTIVE | PASSED | FAILED | PAUSED | CANCELED
  status: text("status").notNull().default("ACTIVE"),
  failureReason: text("failure_reason"),
  startedAt: timestamp("started_at").defaultNow().notNull(),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  byStatus: index("prop_challenges_status_idx").on(t.status),
  byPaper:  index("prop_challenges_paper_idx").on(t.paperAccountId),
}));
export type PropChallenge = typeof propChallengesTable.$inferSelect;

export const propChallengeDaysTable = pgTable("prop_challenge_days", {
  id: serial("id").primaryKey(),
  challengeId: integer("challenge_id").notNull(),
  userId: integer("user_id"),
  tradeDate: text("trade_date").notNull(), // YYYY-MM-DD UTC
  startingBalance: real("starting_balance").notNull(),
  endingBalance:   real("ending_balance").notNull(),
  dailyProfitLoss: real("daily_profit_loss").notNull(),
  dailyLossPercent: real("daily_loss_percent").notNull(), // 0..1, 0 if profitable
  tradesTaken: integer("trades_taken").notNull().default(0),
  rulesViolated: text("rules_violated").notNull().default(""), // CSV of violation types
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  byChallenge: index("prop_challenge_days_challenge_idx").on(t.challengeId),
  byDate:      index("prop_challenge_days_date_idx").on(t.tradeDate),
}));
export type PropChallengeDay = typeof propChallengeDaysTable.$inferSelect;

export const propChallengeViolationsTable = pgTable("prop_challenge_violations", {
  id: serial("id").primaryKey(),
  challengeId: integer("challenge_id").notNull(),
  userId: integer("user_id"),
  // DAILY_LOSS | TOTAL_DRAWDOWN | OVERTRADING | CONSISTENCY | TIME_LIMIT | OTHER
  violationType: text("violation_type").notNull(),
  message: text("message").notNull().default(""),
  // INFO | WARN | HARD (HARD = challenge fails)
  severity: text("severity").notNull().default("WARN"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  byChallenge: index("prop_challenge_violations_challenge_idx").on(t.challengeId),
}));
export type PropChallengeViolation = typeof propChallengeViolationsTable.$inferSelect;

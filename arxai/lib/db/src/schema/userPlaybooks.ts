// Phase 7A/7B — Per-user trading playbooks, rules, and pre-trade checks.
// Additive tables (do not collide with legacy trading_playbooks).
// Read-only against safety surfaces; no broker execution paths.
import { pgTable, serial, integer, text, real, timestamp, jsonb, index } from "drizzle-orm/pg-core";

export const userPlaybooksTable = pgTable("user_playbooks", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  strategyType: text("strategy_type").notNull(),
  marketType: text("market_type"),
  preferredSymbols: jsonb("preferred_symbols").$type<string[]>().default([]),
  preferredSessions: jsonb("preferred_sessions").$type<string[]>().default([]),
  timeframe: text("timeframe"),
  entryModel: text("entry_model").notNull().default(""),
  exitModel: text("exit_model").notNull().default(""),
  riskModel: text("risk_model").notNull().default(""),
  invalidationRules: jsonb("invalidation_rules").$type<string[]>().default([]),
  confirmationRules: jsonb("confirmation_rules").$type<string[]>().default([]),
  avoidRules: jsonb("avoid_rules").$type<string[]>().default([]),
  checklist: jsonb("checklist").$type<string[]>().default([]),
  status: text("status").notNull().default("draft"), // draft|active|archived
  source: text("source").notNull().default("manual"), // manual|ai_generated|from_trade_history|from_single_trade
  confidenceScore: real("confidence_score"),
  winRateSnapshot: real("win_rate_snapshot"),
  sampleSize: integer("sample_size"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  userIdx: index("user_playbooks_user_idx").on(t.userId),
  statusIdx: index("user_playbooks_status_idx").on(t.status),
}));
export type UserPlaybook = typeof userPlaybooksTable.$inferSelect;
export type InsertUserPlaybook = typeof userPlaybooksTable.$inferInsert;

export const playbookRulesV2Table = pgTable("playbook_rules_v2", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  playbookId: integer("playbook_id").notNull(),
  ruleType: text("rule_type").notNull(), // entry|exit|risk|avoid|confirmation|session|psychology
  ruleText: text("rule_text").notNull(),
  severity: text("severity").notNull().default("recommended"), // required|recommended|optional
  orderIndex: integer("order_index").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  userIdx: index("playbook_rules_v2_user_idx").on(t.userId),
  playbookIdx: index("playbook_rules_v2_playbook_idx").on(t.playbookId),
}));
export type PlaybookRuleV2 = typeof playbookRulesV2Table.$inferSelect;

export const preTradeChecksTable = pgTable("pre_trade_checks", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  playbookId: integer("playbook_id").notNull(),
  paperTradeId: integer("paper_trade_id"),
  tradingSessionId: integer("trading_session_id"),
  symbol: text("symbol").notNull(),
  side: text("side"),
  checklistResult: jsonb("checklist_result").$type<Array<{ rule: string; severity: string; passed: boolean; ruleType: string }>>().default([]),
  passedRequiredCount: integer("passed_required_count").notNull().default(0),
  failedRequiredCount: integer("failed_required_count").notNull().default(0),
  score: real("score").notNull().default(0),
  decision: text("decision").notNull(), // pass|warning|block
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  userIdx: index("pre_trade_checks_user_idx").on(t.userId),
  playbookIdx: index("pre_trade_checks_playbook_idx").on(t.playbookId),
}));
export type PreTradeCheck = typeof preTradeChecksTable.$inferSelect;

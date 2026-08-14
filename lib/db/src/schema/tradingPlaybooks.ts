import { pgTable, serial, integer, text, real, timestamp, index } from "drizzle-orm/pg-core";

// (V) Build V — Personal Trading Playbook System.
// Two tables. Living document of a trader's best setups, worst mistakes,
// strongest rules. Entries can be manual or auto-suggested from journal /
// debriefs / weekly reviews. Read-only against safety surfaces.

export const tradingPlaybooksTable = pgTable("trading_playbooks", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  isActive: integer("is_active").notNull().default(1),  // 0/1
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  byActive: index("trading_playbooks_active_idx").on(t.isActive),
}));
export type TradingPlaybook = typeof tradingPlaybooksTable.$inferSelect;

// Canonical entry types — see ENTRY_TYPES in route file.
export const playbookEntriesTable = pgTable("playbook_entries", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"),
  playbookId: integer("playbook_id").notNull(),
  entryType: text("entry_type").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  // Soft refs (advisory; no FK enforcement to keep cross-table flex)
  relatedStrategyId: integer("related_strategy_id"),
  relatedTradeId:    integer("related_trade_id"),
  relatedReviewId:   integer("related_review_id"),
  // 0..100 — manual default 70, AI seeded by evidence count
  confidenceScore: real("confidence_score").notNull().default(70),
  // MANUAL | AI | JOURNAL | DEBRIEF | REVIEW
  source: text("source").notNull().default("MANUAL"),
  isActive: integer("is_active").notNull().default(1),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  byPlaybook: index("playbook_entries_playbook_idx").on(t.playbookId),
  byType:     index("playbook_entries_type_idx").on(t.entryType),
  byActive:   index("playbook_entries_active_idx").on(t.isActive),
}));
export type PlaybookEntry = typeof playbookEntriesTable.$inferSelect;

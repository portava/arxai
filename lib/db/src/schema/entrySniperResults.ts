import { pgTable, serial, integer, real, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Phase 10: each row scores a real or simulated entry against the ideal one.
export const entrySniperResultsTable = pgTable("entry_sniper_results", {
  id: serial("id").primaryKey(),
  signalId: integer("signal_id"),
  tradeId: integer("trade_id"),
  symbol: text("symbol").notNull(),
  originalEntry: real("original_entry").notNull(),
  idealEntry: real("ideal_entry").notNull(),
  actualEntry: real("actual_entry").notNull(),
  earlyEntryScore: integer("early_entry_score").notNull().default(0),
  lateEntryScore: integer("late_entry_score").notNull().default(0),
  actualEntryScore: integer("actual_entry_score").notNull().default(0),
  maxFavorableMove: real("max_favorable_move").notNull().default(0),
  maxAdverseMove: real("max_adverse_move").notNull().default(0),
  entryQualityScore: integer("entry_quality_score").notNull().default(0),
  lesson: text("lesson"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertEntrySniperResultSchema = createInsertSchema(entrySniperResultsTable).omit({ id: true, createdAt: true });
export type InsertEntrySniperResult = z.infer<typeof insertEntrySniperResultSchema>;
export type EntrySniperResult = typeof entrySniperResultsTable.$inferSelect;

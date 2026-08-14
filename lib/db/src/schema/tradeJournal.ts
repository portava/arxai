import { pgTable, serial, text, real, timestamp, integer, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const tradeJournalTable = pgTable("trade_journal", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"), // Phase-2 ownership column.
  symbol: text("symbol").notNull(),
  direction: text("direction").notNull(),
  strategy: text("strategy").notNull(),
  entryIdea: text("entry_idea").notNull(),
  actualOutcome: text("actual_outcome"),
  pnl: real("pnl"),
  emotionTag: text("emotion_tag"),
  mistakeTag: text("mistake_tag"),
  lessonLearned: text("lesson_learned"),
  screenshotUrl: text("screenshot_url"),
  createdAt: timestamp("created_at").defaultNow(),
}, (t) => ({
  userIdx: index("trade_journal_user_id_idx").on(t.userId),
}));

export const insertTradeJournalSchema = createInsertSchema(tradeJournalTable).omit({ id: true, createdAt: true });
export type InsertTradeJournal = z.infer<typeof insertTradeJournalSchema>;
export type TradeJournal = typeof tradeJournalTable.$inferSelect;

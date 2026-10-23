import { pgTable, serial, integer, text, real, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Audit trail for every action taken on a trade after it opens.
export const tradeManagementEventsTable = pgTable("trade_management_events", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"), // Phase-2 ownership column.
  tradeId: integer("trade_id").notNull(),
  eventType: text("event_type").notNull(),  // MOVE_SL | MOVE_TP | TRAIL_STOP | PARTIAL_CLOSE | CLOSE | BREAKEVEN | NOTE
  oldValue: real("old_value"),
  newValue: real("new_value"),
  reason: text("reason"),
  aiSuggestion: text("ai_suggestion"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  userIdx: index("trade_management_events_user_id_idx").on(t.userId),
}));

export const insertTradeManagementEventSchema = createInsertSchema(tradeManagementEventsTable).omit({ id: true, createdAt: true });
export type InsertTradeManagementEvent = z.infer<typeof insertTradeManagementEventSchema>;
export type TradeManagementEvent = typeof tradeManagementEventsTable.$inferSelect;

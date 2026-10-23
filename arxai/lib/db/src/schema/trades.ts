import { pgTable, serial, text, integer, real, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const tradesTable = pgTable("trades", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"), // Phase-2 ownership column. Nullable for legacy rows.
  symbol: text("symbol").notNull(),
  direction: text("direction").notNull(), // BUY, SELL
  lot: real("lot").notNull(),
  entryPrice: real("entry_price").notNull(),
  stopLoss: real("stop_loss").notNull(),
  takeProfit: real("take_profit").notNull(),
  strategy: text("strategy").notNull(),
  confidence: integer("confidence").notNull(),
  status: text("status").notNull().default("OPEN"), // OPEN, CLOSED_WIN, CLOSED_LOSS, CANCELLED
  mode: text("mode").notNull().default("DEMO"), // DEMO, LIVE
  pnl: real("pnl"),
  // Mirrors the live-test-cycle pnlStatus contract. Nullable for legacy /
  // demo rows where the value is implicitly COMPUTED (or PENDING for OPEN).
  // When set to "UNKNOWN" the row MUST be excluded from any P/L aggregate
  // and the UI MUST render "P/L unavailable" instead of the numeric pnl.
  // See artifacts/api-server/src/lib/live/realizedPnl.ts.
  pnlStatus: text("pnl_status"), // null | "PENDING" | "COMPUTED" | "UNKNOWN"
  dataQualityFlag: text("data_quality_flag"), // e.g. "MISSING_CLOSE_FILL_PRICE"
  // Mirror of `reported_ea_version` on `arx_live_test_cycles`. Records the EA
  // version that reported the close when pnlStatus is set to "UNKNOWN", so the
  // Trade Logs UI can show the "upgrade to v1.28" nudge for rows closed by an
  // EA older than v1.28 (the first version that reports the broker's real
  // close fill price). Null for legacy/demo rows or when the EA did not report.
  reportedEaVersion: text("reported_ea_version"),
  closedAt: timestamp("closed_at"),
  createdAt: timestamp("created_at").defaultNow(),
}, (t) => ({
  userIdx: index("trades_user_id_idx").on(t.userId),
}));

export const insertTradeSchema = createInsertSchema(tradesTable).omit({ id: true, createdAt: true });
export type InsertTrade = z.infer<typeof insertTradeSchema>;
export type Trade = typeof tradesTable.$inferSelect;

import { pgTable, serial, integer, text, real, timestamp, index, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// ── ARX AI Paper Trade Ideas (May 2026) ────────────────────────────────────
//
// SAFETY: This table records AI-generated trade ideas in a paper-only
// lifecycle. It is COMPLETELY isolated from `trades`, `live_positions`,
// `mt5_*`, and the broker placement layer. Recording an idea NEVER
// touches a real broker. Status transitions are advisory only.
//
// Lifecycle (single-direction; no looping back):
//   WATCHLIST  — AI flagged a setup; observer-only.
//   PAPER_OPEN — User chose to paper-track it as if entered.
//   PAPER_CLOSED — Paper position closed (TP/SL/manual exit on paper book).
//   REJECTED   — User dismissed the idea (with reason).

export const paperTradeIdeasTable = pgTable("paper_trade_ideas", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"),
  symbol: text("symbol").notNull(),
  direction: text("direction").notNull(), // BUY | SELL
  // Per-idea trade plan (advisory only).
  entryIdea: real("entry_idea").notNull(),
  stopLossIdea: real("stop_loss_idea").notNull(),
  takeProfitIdea: real("take_profit_idea").notNull(),
  // Risk and confidence are 0..100 scales used by the dashboard.
  riskPercent: real("risk_percent").notNull().default(0.5),
  confidenceScore: real("confidence_score").notNull().default(0),
  riskScore: real("risk_score").notNull().default(0),
  suggestedLot: real("suggested_lot").notNull().default(0),
  // Free-form AI explanation surfaced verbatim on the dashboard.
  aiReasoning: text("ai_reasoning").notNull().default(""),
  // Strategy/source identifier (e.g. "trend-continuation").
  strategySource: text("strategy_source"),
  // Snapshot of the inputs used so each idea is reproducible/auditable.
  inputs: jsonb("inputs").notNull().default({}),
  // WATCHLIST | PAPER_OPEN | PAPER_CLOSED | REJECTED
  status: text("status").notNull().default("WATCHLIST"),
  // Optional close-out fields (only set when status moves to PAPER_CLOSED).
  outcomePnl: real("outcome_pnl"),
  outcomeNote: text("outcome_note"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  byStatus: index("paper_trade_ideas_status_idx").on(t.status),
  bySymbol: index("paper_trade_ideas_symbol_idx").on(t.symbol),
  byCreated: index("paper_trade_ideas_created_idx").on(t.createdAt),
}));

export const insertPaperTradeIdeaSchema = createInsertSchema(paperTradeIdeasTable).omit({
  id: true, createdAt: true, updatedAt: true,
});
export type InsertPaperTradeIdea = z.infer<typeof insertPaperTradeIdeaSchema>;
export type PaperTradeIdea = typeof paperTradeIdeasTable.$inferSelect;

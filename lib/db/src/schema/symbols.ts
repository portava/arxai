import { pgTable, serial, text, real, integer, jsonb, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Symbol registry — single source of truth for every tradable instrument.
export const symbolsTable = pgTable("symbols", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull().unique(),                 // canonical id, e.g. "EURUSD"
  displayName: text("display_name").notNull(),               // "EUR / USD"
  marketType: text("market_type").notNull(),                 // forex | indices | stocks | synthetic | crypto
  brokerSymbol: text("broker_symbol").notNull(),             // MT5 broker ticker (often = symbol)
  riskLevel: text("risk_level").notNull().default("MEDIUM"), // LOW | MEDIUM | HIGH | EXTREME
  recommendedTimeframes: jsonb("recommended_timeframes").$type<string[]>().notNull().default([]),
  tradingSessions:       jsonb("trading_sessions").$type<string[]>().notNull().default([]),
  minimumConfidence: integer("minimum_confidence").notNull().default(70),
  defaultRiskPerTrade: real("default_risk_per_trade").notNull().default(0.5),
  notes: text("notes").default(""),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertSymbolSchema = createInsertSchema(symbolsTable).omit({ id: true, createdAt: true });
export type InsertSymbol = z.infer<typeof insertSymbolSchema>;
export type SymbolRow = typeof symbolsTable.$inferSelect;

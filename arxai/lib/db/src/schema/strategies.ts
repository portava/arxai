import { pgTable, serial, text, boolean, real, integer, json, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const strategiesTable = pgTable("strategies", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  winRate: real("win_rate").notNull().default(0),
  totalSignals: integer("total_signals").notNull().default(0),
  parameters: json("parameters"),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertStrategySchema = createInsertSchema(strategiesTable).omit({ id: true });
export type InsertStrategy = z.infer<typeof insertStrategySchema>;
export type Strategy = typeof strategiesTable.$inferSelect;

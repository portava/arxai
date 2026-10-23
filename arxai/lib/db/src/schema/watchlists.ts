import { pgTable, serial, text, integer, timestamp, index } from "drizzle-orm/pg-core";

export const watchlistsTable = pgTable("watchlists", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"), // Phase-2 ownership column.
  name: text("name").notNull(),
  category: text("category").notNull().default("Custom"), // Forex Majors, Forex Minors, US Indices, Stocks, Synthetic Volatility, Custom
  createdAt: timestamp("created_at").defaultNow(),
}, (t) => ({
  userIdx: index("watchlists_user_id_idx").on(t.userId),
}));

export const watchlistItemsTable = pgTable("watchlist_items", {
  id: serial("id").primaryKey(),
  watchlistId: integer("watchlist_id").notNull(),
  symbol: text("symbol").notNull(),
  marketType: text("market_type").notNull(), // forex, index, stock, synthetic
  favorite: integer("favorite").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow(),
});

export type Watchlist = typeof watchlistsTable.$inferSelect;
export type WatchlistItem = typeof watchlistItemsTable.$inferSelect;

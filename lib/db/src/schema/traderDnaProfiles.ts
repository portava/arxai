// Trader DNA Profile Cache
//
// Stores the computed DNA profile per user so Ruby can read it instantly
// without recomputing from all trades on every API call.
//
// Updated by background job whenever new paper trades or imported trades arrive.
// Stale after CACHE_TTL_HOURS — recomputed on next request if stale.
//
// SAFETY: Read-only intelligence. Never affects trade execution or permissions.

import {
  pgTable, serial, integer, text, real, boolean,
  timestamp, jsonb, uniqueIndex,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const traderDnaProfilesTable = pgTable("trader_dna_profiles", {
  id:       serial("id").primaryKey(),
  userId:   integer("user_id").notNull().references(() => usersTable.id),

  // ── Sample info ────────────────────────────────────────────────────────
  tradeCount:       integer("trade_count").notNull().default(0),
  paperTradeCount:  integer("paper_trade_count").notNull().default(0),
  importedTradeCount: integer("imported_trade_count").notNull().default(0),
  isMature:         boolean("is_mature").notNull().default(false), // >= 30 closed trades

  // ── Core stats ─────────────────────────────────────────────────────────
  winRate:          real("win_rate"),           // 0-100
  avgWin:           real("avg_win"),
  avgLoss:          real("avg_loss"),
  profitFactor:     real("profit_factor"),
  expectancy:       real("expectancy"),         // avg R per trade
  maxDrawdown:      real("max_drawdown"),
  totalNetPnl:      real("total_net_pnl"),

  // ── Best/worst conditions (stored as JSON) ─────────────────────────────
  bestSymbols:      jsonb("best_symbols").notNull().default([]),    // [{symbol, winRate, count}]
  worstSymbols:     jsonb("worst_symbols").notNull().default([]),
  bestSessions:     jsonb("best_sessions").notNull().default([]),   // [{session, winRate, count}]
  worstSessions:    jsonb("worst_sessions").notNull().default([]),
  bestSetupTypes:   jsonb("best_setup_types").notNull().default([]),
  worstSetupTypes:  jsonb("worst_setup_types").notNull().default([]),

  // ── Behavior patterns ──────────────────────────────────────────────────
  commonMistakes:   jsonb("common_mistakes").notNull().default([]), // string[]
  strengths:        jsonb("strengths").notNull().default([]),       // string[]
  disciplineScore:  real("discipline_score"),  // 0-100

  // ── Full computed profile (raw domain output, for Ruby deep access) ────
  fullProfile:      jsonb("full_profile").notNull().default({}),

  // ── Cache control ──────────────────────────────────────────────────────
  computedAt:       timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  dataHash:         text("data_hash"),  // hash of input trade IDs — detect when recompute needed

  createdAt:        timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:        timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userUdx: uniqueIndex("tdp_user_udx").on(t.userId),
}));

export type TraderDnaProfileRow = typeof traderDnaProfilesTable.$inferSelect;

export const CACHE_TTL_HOURS = 6; // recompute if older than this

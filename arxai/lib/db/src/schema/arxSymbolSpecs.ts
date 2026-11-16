// Task #30 — Broker symbol specifications (per-user, EA-reported truth).
//
// PURPOSE: ARX must stop guessing broker rules. The EA reports each symbol's
// real broker rules (visibility, tradability, lot min/max/step, digits, point,
// tick value/size, stops/freeze level, spread, session state) for the symbols
// in its Market Watch. ARX stores the latest snapshot per (user, symbol) and
// uses it in validation instead of the static guessed registry.
//
// SAFETY: additive, per-user, fail-closed. A missing row means "no broker truth
// yet" — callers fall back to the static registry and never assume permissive
// values. This table NEVER enables execution; it only lets ARX refuse earlier.

import { pgTable, serial, integer, text, boolean, doublePrecision, timestamp, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";

export const arxSymbolSpecsTable = pgTable("arx_symbol_specs", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  bridgeConnectionId: integer("bridge_connection_id"),
  accountType: text("account_type"),               // demo | live | real | contest | unknown

  symbol: text("symbol").notNull(),                 // ARX-facing symbol key
  brokerSymbol: text("broker_symbol"),              // broker's actual symbol name

  visible: boolean("visible"),                      // SYMBOL_VISIBLE
  tradeAllowed: boolean("trade_allowed"),           // derived tradability
  tradeMode: text("trade_mode"),                    // FULL|LONGONLY|SHORTONLY|CLOSEONLY|DISABLED
  marketOpen: boolean("market_open"),               // broker session state at report time

  digits: integer("digits"),
  point: doublePrecision("point"),
  minVolume: doublePrecision("min_volume"),
  maxVolume: doublePrecision("max_volume"),
  volumeStep: doublePrecision("volume_step"),
  contractSize: doublePrecision("contract_size"),
  tickSize: doublePrecision("tick_size"),
  tickValue: doublePrecision("tick_value"),
  stopsLevelPoints: integer("stops_level_points"),
  freezeLevelPoints: integer("freeze_level_points"),
  spreadPoints: integer("spread_points"),           // current spread snapshot

  // T033 Phase 6 — v1.50 enumeration adds these. Additive; legacy rows leave
  // them null. Bid/ask + currencies + filling/order modes for the symbols UI.
  bid: doublePrecision("bid"),
  ask: doublePrecision("ask"),
  tickSizeV150: doublePrecision("tick_size_v150"),   // reserved alias (tickSize already exists)
  marginCurrency: text("margin_currency"),
  profitCurrency: text("profit_currency"),
  fillingModes: text("filling_modes"),               // CSV/text of allowed filling modes
  orderModes: text("order_modes"),                   // CSV/text of allowed order modes
  category: text("category"),                         // forex|metal|crypto|index|synthetic|...
  displaySymbol: text("display_symbol"),              // friendly label if EA/registry supplies
  reasonNotTradable: text("reason_not_tradable"),     // when tradeAllowed=false
  lastTickTime: timestamp("last_tick_time", { withTimezone: true }),
  selectResult: boolean("select_result"),             // SymbolSelect() result if provided

  // Freshness — same model as the snapshot tables. snapshotAt = when the EA
  // captured this enumeration; lastSeenAt = last enumeration that included it.
  snapshotAt: timestamp("snapshot_at", { withTimezone: true }),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),

  // Raw EA symbol object for admin diagnostics.
  raw: jsonb("raw"),

  reportedAt: timestamp("reported_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userSymbolUq: uniqueIndex("arx_symbol_specs_user_symbol_uq").on(t.userId, t.symbol),
  userIdx: index("arx_symbol_specs_user_idx").on(t.userId),
}));

export type ArxSymbolSpec = typeof arxSymbolSpecsTable.$inferSelect;
export type NewArxSymbolSpec = typeof arxSymbolSpecsTable.$inferInsert;

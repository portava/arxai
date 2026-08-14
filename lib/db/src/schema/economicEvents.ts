import { pgTable, serial, text, integer, timestamp, real, index, uniqueIndex } from "drizzle-orm/pg-core";

// (N) Build N — Economic events table. Sourced from a pluggable provider
// (mock by default; real API replaceable). Append-on-sync, deduped by
// (source, externalId). Indexed by event_time for upcoming-events queries.
export const economicEventsTable = pgTable("economic_events", {
  id: serial("id").primaryKey(),
  externalId: text("external_id").notNull(),                // provider's stable id
  eventName: text("event_name").notNull(),
  country: text("country").notNull(),
  currency: text("currency").notNull(),
  // (N) Spec impact levels: LOW, MEDIUM, HIGH, CRITICAL.
  impactLevel: text("impact_level").notNull(),
  forecast: text("forecast"),
  previous: text("previous"),
  actual: text("actual"),
  eventTime: timestamp("event_time").notNull(),
  source: text("source").notNull().default("mock"),
  affectedSymbols: text("affected_symbols").array(),        // optional pre-known symbol list
  // Heuristic flag set when actual differs heavily from forecast (>50% delta).
  volatilityFlag: integer("volatility_flag").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  byEventTime:  index("eco_events_event_time_idx").on(t.eventTime),
  byImpact:     index("eco_events_impact_idx").on(t.impactLevel),
  byCurrency:   index("eco_events_currency_idx").on(t.currency),
  uniqExternal: uniqueIndex("eco_events_source_external_uq").on(t.source, t.externalId),
}));

export type EconomicEvent = typeof economicEventsTable.$inferSelect;

// (N) News risk reports — per-symbol assessment computed from current
// economic_events. Append-only history. Latest row per symbol is what
// downstream consumers (trade plan, execution safety guard) read.
export const newsRiskReportsTable = pgTable("news_risk_reports", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"),
  symbol: text("symbol").notNull(),
  relatedCurrency: text("related_currency"),
  eventId: integer("event_id"),                 // FK-ish to economic_events.id (nullable)
  // (N) Spec risk labels: CLEAR, CAUTION, HIGH_RISK, NO_TRADE_WINDOW.
  riskLevel: text("risk_level").notNull(),
  timeUntilEventMinutes: real("time_until_event_minutes"),
  tradeWarning: text("trade_warning"),
  aiSummary: text("ai_summary").notNull(),
  // Snapshot of inputs used so an audit can replay the decision.
  inputsSnapshot: text("inputs_snapshot"),      // small JSON string
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  bySymbolCreated: index("news_risk_symbol_created_idx").on(t.symbol, t.createdAt),
  byCreated:       index("news_risk_created_idx").on(t.createdAt),
}));

export type NewsRiskReport = typeof newsRiskReportsTable.$inferSelect;

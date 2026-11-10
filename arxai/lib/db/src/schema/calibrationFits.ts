// Calibration fits — versioned, append-only.
//
// One row per (fit_key, version). A refit that sees new graded outcomes for a
// key appends version+1; it never rewrites an earlier version, so any number a
// payload served can be traced to the exact fit (fit_key + version) behind it.
//
// fit_key is `strategy|symbol|timeframe` ("*" pools a dimension). `source`
// names where the graded outcomes came from:
//   eleanor_outcomes   resolved eleanor_signal_outcomes rows (live signals)
//   scanner_outcomes   resolved outcomes of scanner-originated signals
//   strategy_replay    strategy signals replayed on STORED broker candles and
//                      graded first-touch on the bars after the signal
//   agent_predictions  an agent's own graded predictions (agent trust)
//
// OBSERVATION ONLY. Nothing here touches an order path.

import {
  pgTable, serial, integer, text, real, boolean, timestamp, jsonb, index, uniqueIndex,
} from "drizzle-orm/pg-core";

export const calibrationFitsTable = pgTable("calibration_fits", {
  id:             serial("id").primaryKey(),
  fitKey:         text("fit_key").notNull(),
  version:        integer("version").notNull(),
  source:         text("source").notNull(),
  strategy:       text("strategy").notNull(),
  symbol:         text("symbol").notNull(),
  timeframe:      text("timeframe").notNull(),
  method:         text("method").notNull(),
  status:         text("status").notNull(),          // measured | unmeasured
  model:          text("model").notNull(),           // isotonic | base_rate | none
  n:              integer("n").notNull(),
  wins:           integer("wins").notNull(),
  baseRate:       real("base_rate"),
  brier:          real("brier"),
  brierBaseline:  real("brier_baseline"),
  brierRaw:       real("brier_raw"),
  edgeDetected:   boolean("edge_detected").notNull().default(false),
  /** The full pure-engine CalibrationFit (blocks, cv, reliability). */
  fit:            jsonb("fit").$type<Record<string, unknown>>().notNull(),
  dataFrom:       timestamp("data_from", { withTimezone: true }),
  dataTo:         timestamp("data_to", { withTimezone: true }),
  fittedAt:       timestamp("fitted_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  keyVersionUx: uniqueIndex("calibration_fits_key_version_ux").on(t.fitKey, t.version),
  keyIdx:       index("calibration_fits_key_idx").on(t.fitKey),
  strategyIdx:  index("calibration_fits_strategy_idx").on(t.strategy),
}));

export type CalibrationFitRow = typeof calibrationFitsTable.$inferSelect;
export type CalibrationFitInsert = typeof calibrationFitsTable.$inferInsert;

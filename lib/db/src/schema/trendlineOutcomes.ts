// Task #649 — Trendline Truth learning loop.
//
// SAFETY / SCOPE:
//   - OBSERVATION ONLY. A row records a trendline that the deterministic detector
//     already surfaced, plus what happened AFTER. Writing/resolving a row NEVER
//     places, modifies or closes a trade and NEVER touches the MT5 bridge or the
//     live (16-gate) pipeline. It is read-only over outcomes.
//   - The reliability stats derived from these rows feed ONLY Ruby's bounded
//     confidence ADJUSTMENT — they remain subject to the Trendline Truth hard
//     boundary (display/decision-support only; never produce READY_NOW, never
//     override feed/risk/trade-health gates, never an execution path).
//   - FAIL-CLOSED resolution: `outcome` is graded ONLY on real evidence (a
//     matched closed trade, or an observed decisive move past the confirmation /
//     invalidation level). Elapsed time alone NEVER grades a row — it stays
//     PENDING / UNRESOLVED.
//   - Per-user isolation: `userId` scopes every row. No row from user A is ever
//     returned to user B.
//   - Synthetic-market rows carry `isSynthetic=true` so aggregation can track
//     synthetic stats SEPARATELY from forex / indices (their behaviour differs).
//
// Constrained text vocabularies (validated in app code, not DB enums) mirror the
// shared TrendlineTruthVerdict contract:
//   bias              : bullish | bearish | neutral
//   statusAtDetection : forming | confirmed | broken | retesting | reclaimed
//                     | failed | exhausted
//   feedStatusAtDetection : LIVE | DELAYED | HISTORICAL | UNCONFIRMED
//   outcome           : PENDING | WIN | LOSS | BREAKEVEN | FALSE_POSITIVE
//                     | INVALIDATED | EXPIRED | UNRESOLVED
//   session           : asian | london | overlap | newyork

import {
  pgTable,
  serial,
  integer,
  text,
  doublePrecision,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const trendlineOutcomesTable = pgTable(
  "trendline_outcomes",
  {
    id: serial("id").primaryKey(),
    // Stable external id for the detected-trendline observation (dedupe key base).
    outcomeId: text("outcome_id").notNull(),
    userId: integer("user_id").notNull(),

    // ── "At detection" snapshot (frozen once locked) ──────────────────────────
    symbol: text("symbol").notNull(),
    displayName: text("display_name"),
    assetClass: text("asset_class"),
    isSynthetic: boolean("is_synthetic").notNull().default(false),
    timeframe: text("timeframe").notNull().default(""),
    session: text("session"), // asian | london | overlap | newyork

    trendlineId: text("trendline_id").notNull(), // e.g. ascending_support
    trendlineName: text("trendline_name").notNull(),
    trendlineCategory: text("trendline_category"), // trend_support | channel | ...
    bias: text("bias").notNull().default("neutral"),
    statusAtDetection: text("status_at_detection").notNull(),
    qualityAtDetection: text("quality_at_detection"), // high|medium|low|none
    confidenceAtDetection: doublePrecision("confidence_at_detection").notNull().default(0),

    // Feed honesty at detection — drives whether this row may count as a "live"
    // confirmation in aggregation, or stays context-only.
    feedStatusAtDetection: text("feed_status_at_detection").notNull().default("UNCONFIRMED"),

    // Trendline geometry levels at detection.
    confirmationLevel: doublePrecision("confirmation_level"),
    invalidationLevel: doublePrecision("invalidation_level"),
    targetLevel: doublePrecision("target_level"),

    // Setup numbers at detection (if a setup was projected).
    entryPrice: doublePrecision("entry_price"),
    stopLoss: doublePrecision("stop_loss"),
    takeProfit: doublePrecision("take_profit"),

    // Context at detection (read-only telemetry).
    spreadAtDetection: doublePrecision("spread_at_detection"),
    newsNearby: boolean("news_nearby").notNull().default(false),
    newsWindowMinutes: integer("news_window_minutes"),

    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),

    // ── Resolved-on-evidence facts (appended, never an in-place rewrite) ───────
    // Optional link to a real trade once one is taken on this trendline.
    tradeId: integer("trade_id"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),

    realizedR: doublePrecision("realized_r"), // realized reward:risk multiple
    maxFavorableExcursionR: doublePrecision("mfe_r"), // MFE in R
    maxAdverseExcursionR: doublePrecision("mae_r"), // MAE in R

    outcome: text("outcome").notNull().default("PENDING"),
    outcomeReason: text("outcome_reason"), // win/loss reason (TP|SL|INVALIDATED|...)
    postTradeReview: text("post_trade_review"),

    // Once locked, the at-detection snapshot is immutable; later facts append.
    locked: boolean("locked").notNull().default(false),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),

    extra: jsonb("extra"), // optional structured detail (rationale, failureModes)
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userOutcomeUq: uniqueIndex("trendline_outcomes_user_outcome_uq").on(t.userId, t.outcomeId),
    userSymbolTfIdx: index("trendline_outcomes_user_symbol_tf_idx").on(
      t.userId,
      t.symbol,
      t.timeframe,
    ),
    userTrendlineIdx: index("trendline_outcomes_user_trendline_idx").on(t.userId, t.trendlineId),
    userOutcomeStatusIdx: index("trendline_outcomes_user_outcome_status_idx").on(
      t.userId,
      t.outcome,
    ),
  }),
);

export type TrendlineOutcome = typeof trendlineOutcomesTable.$inferSelect;
export type NewTrendlineOutcome = typeof trendlineOutcomesTable.$inferInsert;

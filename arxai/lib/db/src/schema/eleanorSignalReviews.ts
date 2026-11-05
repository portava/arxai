// Task #199 — Outcome Learning & Admin Quality: post-trade Eleanor self-reviews.
//
// SAFETY / SCOPE:
//   - APPEND-ONLY. A self-review is generated when a tracked signal resolves on
//     real evidence (a closed trade or a credited no-trade). It NEVER edits the
//     locked eleanor_signal_outcomes snapshot and NEVER touches any execution path.
//   - Per-user isolation: userId scopes every row. `userSummary` is the
//     simplified user-facing text; `adminDetail` holds the detailed breakdown
//     and is ONLY ever returned to ADMIN/OWNER sessions — never to users or
//     investors.
//
// Constrained text vocabularies (validated in app code, not DB enums):
//   reviewType    : POST_TRADE | NO_TRADE

import {
  pgTable, serial, integer, text, timestamp, jsonb, index, uniqueIndex,
} from "drizzle-orm/pg-core";

export const eleanorSignalReviewsTable = pgTable("eleanor_signal_reviews", {
  id:            serial("id").primaryKey(),
  reviewId:      text("review_id").notNull(),       // stable external id
  outcomeId:     text("outcome_id").notNull(),      // -> eleanor_signal_outcomes.outcomeId
  userId:        integer("user_id").notNull(),      // per-user isolation

  reviewType:    text("review_type").notNull().default("POST_TRADE"), // POST_TRADE|NO_TRADE
  outcomeStatus: text("outcome_status").notNull(),

  userSummary:   text("user_summary").notNull(),    // simplified for users
  adminDetail:   jsonb("admin_detail").$type<Record<string, unknown>>().default({}), // admin-only

  createdAt:     timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  reviewIdUx:   uniqueIndex("eleanor_signal_reviews_review_id_ux").on(t.reviewId),
  outcomeUx:    uniqueIndex("eleanor_signal_reviews_outcome_ux").on(t.outcomeId),
  userIdx:      index("eleanor_signal_reviews_user_idx").on(t.userId),
}));

export type EleanorSignalReviewRow = typeof eleanorSignalReviewsTable.$inferSelect;
export type EleanorSignalReviewInsert = typeof eleanorSignalReviewsTable.$inferInsert;

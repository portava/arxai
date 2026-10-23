// Agent Ecosystem — append-only prediction reviews (Layer 1 substrate).
//
// SAFETY / SCOPE:
//   - APPEND-ONLY. A locked agent_prediction is never edited; every later
//     observation, outcome grade, or calibration note is a NEW row here
//     referencing predictionId. This is the durable evidence trail Layer 2
//     scoring fills in.
//   - OBSERVATION ONLY — never touches any trade/live path.
//
// Constrained text vocabularies (validated in app code, not DB enums):
//   reviewType     : OUTCOME | OBSERVATION | CALIBRATION
//   realizedOutcome: WIN | LOSS | BREAKEVEN | NO_TRADE_CORRECT
//                  | NO_TRADE_MISSED | EXPIRED | UNRESOLVED
//   grade          : A | B | C | D | F

import {
  pgTable, serial, integer, text, real, timestamp, index, uniqueIndex,
} from "drizzle-orm/pg-core";

export const agentPredictionReviewsTable = pgTable("agent_prediction_reviews", {
  id:               serial("id").primaryKey(),
  reviewId:         text("review_id").notNull(),       // stable external id

  predictionId:     text("prediction_id").notNull(),   // -> agent_predictions.prediction_id
  agentId:          integer("agent_id").notNull(),     // -> agents.id

  reviewType:       text("review_type").notNull().default("OUTCOME"),

  // Six sub-scores (filled by Layer 2; nullable here so the table + types
  // exist now). 0-100.
  decisionQuality:  real("decision_quality"),
  outcomeScore:     real("outcome_score"),
  protectionScore:  real("protection_score"),
  speedScore:       real("speed_score"),
  usefulnessScore:  real("usefulness_score"),
  calibrationScore: real("calibration_score"),

  scoreDelta:       real("score_delta").notNull().default(0),
  grade:            text("grade"),
  rewardTags:       text("reward_tags").notNull().default("[]"),   // JSON array as text
  penaltyTags:      text("penalty_tags").notNull().default("[]"),  // JSON array as text

  realizedOutcome:  text("realized_outcome"),
  realizedPnlR:     real("realized_pnl_r"),
  rationale:        text("rationale"),
  evidence:         text("evidence").notNull().default("{}"),      // JSON object as text

  createdAt:        timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  reviewIdUx:     uniqueIndex("agent_prediction_reviews_review_id_ux").on(t.reviewId),
  predictionIdx:  index("agent_prediction_reviews_prediction_idx").on(t.predictionId),
  agentIdx:       index("agent_prediction_reviews_agent_idx").on(t.agentId),
}));

export type AgentPredictionReviewRow = typeof agentPredictionReviewsTable.$inferSelect;
export type AgentPredictionReviewInsert = typeof agentPredictionReviewsTable.$inferInsert;

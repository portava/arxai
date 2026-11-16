import { pgTable, serial, integer, text, jsonb, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";

// (U) Build U — AI Post-Trade Debrief System.
// One short reflection per closed trade (paper_orders.id). Reads paper_orders
// to verify the trade is closed; never references live trades, mt5_*, or
// /execute-trade. AI feedback is heuristic + based on stored trade fields,
// no external LLM call required.

export const postTradeDebriefsTable = pgTable("post_trade_debriefs", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"),
  tradeId: integer("trade_id").notNull(),                           // paper_orders.id (advisory FK)
  // WIN | LOSS | BREAKEVEN | UNKNOWN — mirrored from the closed trade
  result: text("result").notNull().default("UNKNOWN"),
  // 7-item structured checklist (jsonb) — see DEBRIEF_QUESTIONS in route file
  checklist: jsonb("checklist").notNull().default([]),
  followedPlan: integer("followed_plan").notNull().default(0),      // 0/1 derived from checklist
  // Self-report: emotion after trade
  traderEmotionAfter: text("trader_emotion_after"),                 // CALM | FRUSTRATED | RELIEVED | EUPHORIC | NEUTRAL | ANXIOUS | DISAPPOINTED
  biggestMistake:    text("biggest_mistake"),
  biggestStrength:   text("biggest_strength"),
  lessonLearned:     text("lesson_learned"),
  // AI-generated narrative + drill recommendation
  aiFeedback:        text("ai_feedback").notNull().default(""),
  recommendedDrill:  text("recommended_drill").notNull().default(""),
  // (BB) Build AA decision linkage (advisory FK to trade_decision_logs.id).
  decisionId: integer("decision_id"),
  // (BB) USER (manual) | SYSTEM_AUTO_DEBRIEF (Build BB closed-loop trigger).
  createdBy: text("created_by").notNull().default("USER"),
  // (BB) Full structured auto-debrief payload as defined in Build BB spec.
  autoMeta: jsonb("auto_meta").notNull().default({}),
  // (BB) Build CC handoff payload — prepared but NOT consumed yet.
  learningPayload: jsonb("learning_payload").notNull().default({}),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  byTrade:   uniqueIndex("post_trade_debriefs_trade_uq").on(t.tradeId),
  byCreated: index("post_trade_debriefs_created_idx").on(t.createdAt),
}));
export type PostTradeDebrief = typeof postTradeDebriefsTable.$inferSelect;

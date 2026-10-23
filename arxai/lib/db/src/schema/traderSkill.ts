import { pgTable, serial, integer, text, real, timestamp, index } from "drizzle-orm/pg-core";

// (X) Build X — Trader Benchmark & Skill Level System.
// Two tables. Skill is computed from PROCESS QUALITY (discipline, journaling,
// review cadence), NOT short-term P&L. Append-only history of level changes.

export const traderSkillProfilesTable = pgTable("trader_skill_profiles", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"),
  // Beginner | Developing Trader | Disciplined Trader | Consistent Trader | Advanced Trader | Elite Trader
  skillLevel: text("skill_level").notNull().default("Beginner"),
  totalScore: real("total_score").notNull().default(0),
  // Each 0..100
  disciplineScore:       real("discipline_score").notNull().default(0),
  executionScore:        real("execution_score").notNull().default(0),
  riskScore:             real("risk_score").notNull().default(0),
  emotionalControlScore: real("emotional_control_score").notNull().default(0),
  consistencyScore:      real("consistency_score").notNull().default(0),
  planningScore:         real("planning_score").notNull().default(0),
  reviewScore:           real("review_score").notNull().default(0),
  practiceScore:         real("practice_score").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  byLevel: index("trader_skill_level_idx").on(t.skillLevel),
}));
export type TraderSkillProfile = typeof traderSkillProfilesTable.$inferSelect;

export const skillLevelHistoryTable = pgTable("skill_level_history", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"),
  previousLevel: text("previous_level").notNull(),
  newLevel:      text("new_level").notNull(),
  reason:        text("reason").notNull().default(""),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  byCreated: index("skill_level_history_created_idx").on(t.createdAt),
}));
export type SkillLevelHistory = typeof skillLevelHistoryTable.$inferSelect;

// Trading School — per-user learning progress.
//
// One row per authenticated user. Persists the learner's Trading School
// state (lessons started/complete, quiz attempts + best scores, labs
// attempted, earned badges) so it survives device switches and browser
// clears, and so admins can report on who has completed what.
//
// SAFETY / SCOPE:
//   - Education progress only. Touches no trading, execution, balance, or
//     safety surface.
//   - Strictly per-user: every read/write is scoped by user_id; one row per
//     user (unique). No row from user A is ever returned to user B.
//
// The two date fields are stored as ISO text (not timestamps) to keep a 1:1
// transparent round-trip with the client SchoolProgress shape, which uses
// `string | null` ISO dates. ISO-8601 text still sorts chronologically for
// reporting.

import {
  pgTable, serial, integer, text, jsonb, timestamp, index,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export interface SchoolQuizAttempt {
  lessonId: string;
  scorePct: number; // 0..1
  passed: boolean;
  at: string;       // ISO date
}

export const tradingSchoolProgressTable = pgTable("trading_school_progress", {
  id:                 serial("id").primaryKey(),
  userId:             integer("user_id").notNull().unique().references(() => usersTable.id),

  startedAt:          text("started_at"),    // ISO string | null
  completedAt:        text("completed_at"),  // ISO string | null
  lastLessonId:       text("last_lesson_id"),

  completedLessonIds: jsonb("completed_lesson_ids").$type<string[]>().notNull().default([]),
  passedLessonIds:    jsonb("passed_lesson_ids").$type<string[]>().notNull().default([]),
  attempts:           jsonb("attempts").$type<SchoolQuizAttempt[]>().notNull().default([]),
  labsAttempted:      jsonb("labs_attempted").$type<string[]>().notNull().default([]),
  earnedBadgeIds:     jsonb("earned_badge_ids").$type<string[]>().notNull().default([]),

  updatedAt:          timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt:          timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userIdx: index("tsp_user_idx").on(t.userId),
}));

export type TradingSchoolProgressRow = typeof tradingSchoolProgressTable.$inferSelect;

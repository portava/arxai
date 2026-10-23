// Build UU — Tester feedback / issue tracker schema. Additive. No trade
// execution columns. No live-trading flags. No secret columns. All payloads
// are scrubbed by the audit redactor before being persisted.

import { pgTable, serial, text, jsonb, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";

export const feedbackTable = pgTable("feedback", {
  id: serial("id").primaryKey(),
  feedbackId: text("feedback_id").notNull(),
  title: text("title").notNull(),
  category: text("category").notNull(),         // BUG | FEATURE | UI | TRADING | CHART | AI | RISK | JOURNAL | MOBILE | MT5 | OTHER
  severity: text("severity").notNull(),         // low | medium | high | critical
  priority: text("priority").notNull().default("P2"), // P0 | P1 | P2 | P3
  status: text("status").notNull().default("NEW"),    // NEW | TRIAGED | IN_PROGRESS | FIXED | NEEDS_RETEST | CLOSED | WONT_FIX
  route: text("route"),
  whatHappened: text("what_happened").notNull(),
  whatExpected: text("what_expected"),
  stepsToReproduce: text("steps_to_reproduce"),
  reporterRole: text("reporter_role").notNull().default("OWNER"),
  currentMode: text("current_mode"),
  mt5Status: text("mt5_status"),
  notes: text("notes"),
  context: jsonb("context").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  feedbackIdIdx: uniqueIndex("feedback_feedback_id_idx").on(t.feedbackId),
  statusIdx: index("feedback_status_idx").on(t.status),
  severityIdx: index("feedback_severity_idx").on(t.severity),
  createdAtIdx: index("feedback_created_at_idx").on(t.createdAt),
}));

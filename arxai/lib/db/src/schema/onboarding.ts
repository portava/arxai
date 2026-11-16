// Build RR — Guided Onboarding + Smart Help System schema.
//
// SAFETY: All tables additive. No live-trading flags. No secret columns.
// Acknowledgements never grant live trading. Help content is plain English
// only and may not contain executable code or credentials.

import {
  pgTable, serial, text, integer, jsonb, boolean, timestamp, index, uniqueIndex,
} from "drizzle-orm/pg-core";

export const userOnboardingProgressTable = pgTable("user_onboarding_progress", {
  id: serial("id").primaryKey(),
  onboardingId: text("onboarding_id").notNull().unique(),
  userId: integer("user_id"),
  status: text("status").notNull().default("NOT_STARTED"), // NOT_STARTED|IN_PROGRESS|COMPLETED|SKIPPED
  currentStep: text("current_step"),
  completedSteps: jsonb("completed_steps").notNull().default([]),
  skippedSteps: jsonb("skipped_steps").notNull().default([]),
  paperOnlyAcknowledged: boolean("paper_only_acknowledged").notNull().default(false),
  liveDisabledAcknowledged: boolean("live_disabled_acknowledged").notNull().default(false),
  riskDisclaimerAcknowledged: boolean("risk_disclaimer_acknowledged").notNull().default(false),
  replaySimulationAcknowledged: boolean("replay_simulation_acknowledged").notNull().default(false),
  brokerReadonlyAcknowledged: boolean("broker_readonly_acknowledged").notNull().default(false),
  walkthroughCompleted: boolean("walkthrough_completed").notNull().default(false),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userIdx: uniqueIndex("user_onboarding_progress_user_idx").on(t.userId),
  statusIdx: index("user_onboarding_progress_status_idx").on(t.status),
}));

export const onboardingEventsTable = pgTable("onboarding_events", {
  id: serial("id").primaryKey(),
  onboardingId: text("onboarding_id").notNull(),
  eventType: text("event_type").notNull(), // STARTED|STEP_COMPLETED|STEP_SKIPPED|ACKNOWLEDGED|COMPLETED|RESET
  stepId: text("step_id"),
  severity: text("severity").notNull().default("INFO"),
  message: text("message").notNull(),
  details: jsonb("details").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  onbIdx: index("onboarding_events_onb_idx").on(t.onboardingId),
  createdIdx: index("onboarding_events_created_idx").on(t.createdAt),
}));

export const helpContentItemsTable = pgTable("help_content_items", {
  id: serial("id").primaryKey(),
  helpKey: text("help_key").notNull().unique(),
  title: text("title").notNull(),
  category: text("category").notNull().default("GENERAL"),
  pageRoute: text("page_route"),
  content: text("content").notNull(),
  safetyNote: text("safety_note").notNull().default("PAPER_ONLY. Live trading is disabled."),
  relatedBuild: text("related_build"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  categoryIdx: index("help_content_items_category_idx").on(t.category),
  pageIdx: index("help_content_items_page_idx").on(t.pageRoute),
}));

export const blockedActionExplanationsTable = pgTable("blocked_action_explanations", {
  id: serial("id").primaryKey(),
  explanationId: text("explanation_id").notNull().unique(),
  userId: integer("user_id"),
  blockedAction: text("blocked_action").notNull(),
  blockingSystems: jsonb("blocking_systems").notNull().default([]),
  highestSeverity: text("highest_severity").notNull().default("INFO"),
  plainEnglishReasons: jsonb("plain_english_reasons").notNull().default([]),
  technicalReasons: jsonb("technical_reasons").notNull().default([]),
  recommendedFixes: jsonb("recommended_fixes").notNull().default([]),
  safeNextStep: text("safe_next_step"),
  links: jsonb("links").notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  actionIdx: index("blocked_action_explanations_action_idx").on(t.blockedAction),
  createdIdx: index("blocked_action_explanations_created_idx").on(t.createdAt),
}));

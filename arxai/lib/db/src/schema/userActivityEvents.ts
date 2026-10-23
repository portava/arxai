import { pgTable, serial, integer, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// Activity log for safe, non-sensitive user events. NEVER store passwords,
// bridge tokens, or full account credentials in `metadata`.
//
// Event types (initial):
//   USER_REGISTERED, USER_LOGGED_IN, USER_LOGGED_OUT,
//   TRADING_SESSION_CREATED, TRADING_SESSION_CLOSED,
//   MT5_CONNECTION_CREATED, MT5_HEARTBEAT_RECEIVED,
//   PAPER_IDEA_CREATED, AI_ANALYSIS_CREATED,
//   DEMO_COMMAND_QUEUED, DEMO_COMMAND_BLOCKED, SAFETY_GUARD_TRIGGERED
export const userActivityEventsTable = pgTable(
  "user_activity_events",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    userTimeIdx: index("user_activity_events_user_time_idx").on(t.userId, t.createdAt),
    typeIdx: index("user_activity_events_type_idx").on(t.eventType),
  }),
);

export type UserActivityEvent = typeof userActivityEventsTable.$inferSelect;

// Task #210 — Durable password-reset rate limiting.
// Backs the forgot-password throttle with shared/durable storage so the limit
// survives API-server restarts and is consistent across multiple instances
// (the previous implementation was a process-local in-memory Map that reset on
// every restart and was not shared between instances).
//
// Additive schema. One row per forgot-password attempt: a sliding-window count
// of rows per `throttle_key` within the window decides whether a caller is
// throttled. No secrets, no PII beyond the throttle key (ip+email) the route
// already constructs, and no trade-execution columns.

import { pgTable, serial, text, timestamp, index } from "drizzle-orm/pg-core";

export const passwordResetThrottleTable = pgTable(
  "password_reset_throttle",
  {
    id: serial("id").primaryKey(),
    // `${ip}:${email}` — opaque to this layer; the route builds it.
    throttleKey: text("throttle_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Sliding-window count is keyed by (throttle_key, created_at).
    keyCreatedIdx: index("password_reset_throttle_key_created_idx").on(t.throttleKey, t.createdAt),
    // Supports cheap housekeeping deletes of old rows.
    createdAtIdx: index("password_reset_throttle_created_at_idx").on(t.createdAt),
  }),
);

export type PasswordResetThrottleRow = typeof passwordResetThrottleTable.$inferSelect;
export type PasswordResetThrottleInsert = typeof passwordResetThrottleTable.$inferInsert;

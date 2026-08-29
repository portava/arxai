import { pgTable, serial, text, integer, real, timestamp, index } from "drizzle-orm/pg-core";

// Capability #42 — delayed risk-ceiling increases.
//
// Raising any risk ceiling is a two-step, time-delayed action:
//   1. the request is queued here with effectiveAt = requestedAt + delay,
//   2. AFTER effectiveAt the user must explicitly RE-CONFIRM before the value
//      is written into risk_settings.
// Reductions never touch this table — they apply instantly in the route.
//
// `field` names a risk_settings column; `direction` records why the change was
// classified LOOSEN (audit honesty: the classification that queued it is kept).
// Values are stored as reals; boolean settings use 0/1 with valueKind="boolean".
export const riskPendingIncreasesTable = pgTable("risk_pending_increases", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  field: text("field").notNull(),
  valueKind: text("value_kind").notNull().default("number"), // number | boolean
  currentValue: real("current_value").notNull(),
  targetValue: real("target_value").notNull(),
  direction: text("direction").notNull().default("LOOSEN"),
  status: text("status").notNull().default("PENDING"), // PENDING | APPLIED | CANCELLED | SUPERSEDED
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
  /** The moment the waiting period ends. Confirmation before this is refused. */
  effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull(),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userStatusIdx: index("risk_pending_increases_user_status_idx").on(t.userId, t.status),
}));

export type RiskPendingIncreaseRow = typeof riskPendingIncreasesTable.$inferSelect;

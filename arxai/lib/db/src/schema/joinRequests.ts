// Task #203 — Request-to-Join Onboarding.
// Additive schema. No trade-execution columns. No live-trading flags.
// No secret columns. A join request is a prospect asking to be invited; an
// admin Approve issues an invite via the EXISTING beta-invite path (the cohort
// cap + one-time code + audit all live in repositories/betaInvites.ts and are
// NOT duplicated here). Submission never creates an account and never bypasses
// the invite gate. Over-cap submissions are still accepted + queued (waitlist).

import {
  pgTable, serial, text, integer, timestamp, index, uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const joinRequestsTable = pgTable("join_requests", {
  id: serial("id").primaryKey(),
  // Stored lower-cased + trimmed by the repository so dedupe is exact.
  email: text("email").notNull(),
  name: text("name"),
  note: text("note"),
  status: text("status").notNull().default("PENDING"), // PENDING | APPROVED | DECLINED
  source: text("source").notNull().default("request_access"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  decidedByUserId: integer("decided_by_user_id"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  declineReason: text("decline_reason"),
  // Linked beta_invites.id once an admin Approves. Null until then.
  inviteId: integer("invite_id"),
}, (t) => ({
  emailIdx: index("join_requests_email_idx").on(t.email),
  statusIdx: index("join_requests_status_idx").on(t.status),
  createdAtIdx: index("join_requests_created_at_idx").on(t.createdAt),
  // Dedupe: at most one PENDING request per email. Re-submissions while a
  // request is already pending collapse onto the existing row (the public
  // endpoint always returns a neutral confirmation either way — no enumeration).
  pendingEmailIdx: uniqueIndex("join_requests_pending_email_idx")
    .on(t.email)
    .where(sql`status = 'PENDING'`),
}));

export type JoinRequestRow = typeof joinRequestsTable.$inferSelect;
export type JoinRequestInsert = typeof joinRequestsTable.$inferInsert;

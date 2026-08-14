// Task #202 — Self-serve forgot/reset password flow.
// Additive schema. No trade-execution columns, no live-trading flags, no secret
// columns beyond the token HASH. The raw reset token only ever lives in the
// emailed/logged reset link; we persist sha256(rawToken) so a DB leak does not
// yield usable reset credentials (mirrors auth_user_sessions). Tokens are
// single-use (usedAt), expire (expiresAt), and a newer one issued for a user
// invalidates the user's older unused ones (handled in the repository).

import { pgTable, serial, integer, text, timestamp, index } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const passwordResetTokensTable = pgTable(
  "password_reset_tokens",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    // sha256(rawToken) — the raw token is never stored.
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    // Null until the token is consumed by a successful reset (single-use) or
    // pre-emptively invalidated when a newer token is issued for the same user.
    usedAt: timestamp("used_at", { withTimezone: true }),
    ipAddress: text("ip_address"),
  },
  (t) => ({
    userIdx: index("password_reset_tokens_user_idx").on(t.userId),
    expiresAtIdx: index("password_reset_tokens_expires_at_idx").on(t.expiresAt),
  }),
);

export type PasswordResetTokenRow = typeof passwordResetTokensTable.$inferSelect;
export type PasswordResetTokenInsert = typeof passwordResetTokensTable.$inferInsert;

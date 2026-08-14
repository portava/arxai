import { pgTable, serial, integer, text, timestamp, index } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// Per-user login session (separate from the role-only `hr_session` cookie).
// `tokenHash` is sha256(rawToken); the raw token only ever lives in the
// httpOnly cookie. Lookups are by tokenHash so a DB leak does not yield
// usable session tokens.
export const authUserSessionsTable = pgTable(
  "auth_user_sessions",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    lastSeenAt: timestamp("last_seen_at").defaultNow().notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
  },
  (t) => ({
    userIdx: index("auth_user_sessions_user_idx").on(t.userId),
  }),
);

export type AuthUserSession = typeof authUserSessionsTable.$inferSelect;

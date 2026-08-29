import { pgTable, serial, text, integer, timestamp, index } from "drizzle-orm/pg-core";

// Capability #37 — the unified owner-grantable authority ledger.
//
// ONE place where elevated automation authority is declared. A grant is:
//   * scoped   — ACCOUNT | STRATEGY | INSTRUMENT | MISSION (+ scopeRef),
//   * bounded  — maxLevel is a CEILING the existing ladders may rise to,
//   * expiring — expiresAt is NOT NULL; an expired grant is simply absent,
//   * owner-pressed — created only through an authenticated user press with an
//     explicit expiry; nothing in the system self-issues a grant.
//
// The ladders (mission automationLevel, self-trade agent autonomyLevel) READ
// THROUGH this ledger at raise time: an increase above the conservative
// default requires an active grant covering the scope. Reductions never
// consult it. Expiry is enforced two ways: at read time (an expired row never
// matches) and by the authority expiry sweep worker, which REDUCES persisted
// ladder levels whose backing grant has lapsed. Both directions only ever
// lower autonomy automatically — raising always needs a fresh owner press.
//
// The table is a LEDGER, not a limit store: it grants permission to raise,
// it never holds a risk limit (Owner Ruling 4 untouched).
export const authorityGrantsTable = pgTable("authority_grants", {
  id: serial("id").primaryKey(),
  /** External identity (Owner Ruling 3). */
  publicId: text("public_id").notNull(),
  /** The account whose automation this grant governs. */
  userId: integer("user_id").notNull(),
  /** AUTHORITY_KINDS in @workspace/domain/safety-contracts/authorityGrants. */
  kind: text("kind").notNull(),
  /** ACCOUNT | STRATEGY | INSTRUMENT | MISSION. */
  scopeType: text("scope_type").notNull(),
  /** null for ACCOUNT scope; the strategy/agent id, symbol, or mission id otherwise. */
  scopeRef: text("scope_ref"),
  /** Ceiling the covered ladder may be raised to while this grant is active. */
  maxLevel: integer("max_level").notNull(),
  reason: text("reason"),
  grantedByUserId: integer("granted_by_user_id").notNull(),
  grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
  /** Mandatory automatic expiry. Never nullable — an open-ended grant cannot exist. */
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  /** Instant reduction: a revoked grant stops matching immediately. */
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedByUserId: integer("revoked_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userKindIdx: index("authority_grants_user_kind_idx").on(t.userId, t.kind),
  expiryIdx: index("authority_grants_expires_at_idx").on(t.expiresAt),
}));

export type AuthorityGrantRow = typeof authorityGrantsTable.$inferSelect;

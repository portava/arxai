// Phase Private-Beta-10 / Registration Key Shield — invite-only cohort enforcement.
// Additive schema. No trade-execution columns. No live-trading flags.
// No secret columns.
//
// Schema evolution:
//  - email: now nullable (email-optional registration keys)
//  - keyPrefix: stored display prefix e.g. "ARX-9K4M" (shown in admin table; masked display)
//  - roleGrant: nullable role applied at account creation (USER|INVESTOR|ADMIN; bounded at issuance)
//  - updatedAt: row mutation timestamp

import {
  pgTable, serial, text, integer, timestamp, index, uniqueIndex,
} from "drizzle-orm/pg-core";

export const betaInvitesTable = pgTable("beta_invites", {
  id: serial("id").primaryKey(),
  cohort: text("cohort").notNull().default("ARX_PRIVATE_BETA_10"),
  // Nullable: email-optional registration keys set this to null.
  // Assigned-email keys: registration is restricted to this address.
  email: text("email"),
  // Legacy plaintext column. New invites store NULL here; lookups use
  // inviteCodeHash. Kept nullable for backward-compat reads of legacy rows.
  inviteCode: text("invite_code"),
  // SHA-256 hex of the raw invite code (un-peppered) OR of the peppered
  // registration key. Source of truth for lookups. Raw code is returned
  // ONCE from POST /api/admin/beta/invites or /api/admin/registration-keys/generate
  // and never re-served by any endpoint.
  inviteCodeHash: text("invite_code_hash"),
  // Stored display prefix for ARX-format keys. e.g. "ARX-9K4M" (first segment).
  // NULL for pre-registration-key rows. Used to render "ARX-9K4M-****" in the admin table.
  keyPrefix: text("key_prefix"),
  // Role applied at account creation. NULL → defaults to USER. Bounded at issuance.
  // Values: USER | INVESTOR | ADMIN (OWNER never grantable via key).
  roleGrant: text("role_grant"),
  accountMode: text("account_mode").notNull().default("DEMO_TESTER"), // DEMO_TESTER | PERSONAL_MT5 | SHARED_MASTER_REVIEW
  status: text("status").notNull().default("PENDING"),                 // PENDING | ACCEPTED | REVOKED | PAUSED
  invitedByUserId: integer("invited_by_user_id"),
  invitedAt: timestamp("invited_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  acceptedUserId: integer("accepted_user_id"),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedByUserId: integer("revoked_by_user_id"),
  pausedAt: timestamp("paused_at", { withTimezone: true }),
  resumedAt: timestamp("resumed_at", { withTimezone: true }),
  notes: text("notes"),
}, (t) => ({
  inviteCodeIdx: uniqueIndex("beta_invites_code_idx").on(t.inviteCode),
  inviteCodeHashIdx: uniqueIndex("beta_invites_code_hash_idx").on(t.inviteCodeHash),
  emailIdx: index("beta_invites_email_idx").on(t.email),
  statusIdx: index("beta_invites_status_idx").on(t.status),
  cohortIdx: index("beta_invites_cohort_idx").on(t.cohort),
  keyPrefixIdx: index("beta_invites_key_prefix_idx").on(t.keyPrefix),
}));

export type BetaInviteRow = typeof betaInvitesTable.$inferSelect;
export type BetaInviteInsert = typeof betaInvitesTable.$inferInsert;

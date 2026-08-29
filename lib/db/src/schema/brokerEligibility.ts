// R6 multi-broker Phase 0 — per-user × per-venue eligibility rows.
//
// Sources: blueprint §70 "Compliance and Eligibility Gate" (statuses ELIGIBLE /
// RESTRICTED / COMPLIANCE_HOLD / INELIGIBLE with reasons; "Outside-client
// managed accounts remain COMPLIANCE_HOLD until the required approvals
// exist"), spec §1.3 / §9; audit-connections.md gap G-5 (no residency or
// eligibility fields exist anywhere in the schema); audit-workspaces.md
// §4.2–4.3 (beneficial-ownership + COMPLIANCE_HOLD entirely missing).
//
// FAIL-CLOSED POSTURE (spec §1.3): `eligibilityStatus` defaults to
// COMPLIANCE_HOLD. A row that merely exists grants NOTHING — trading
// eligibility requires an explicit, provenance-stamped review that moves the
// status to ELIGIBLE (or RESTRICTED). Callers MUST also treat the ABSENCE of a
// row as COMPLIANCE_HOLD; the pure gate that consumes these rows
// (lib/domain/src/compliance-gate) refuses unknown/missing statuses.
//
// The status vocabulary is owned by lib/domain/src/compliance-gate
// (ELIGIBILITY_STATUSES); this file repeats the literals because lib/db does
// not depend on @workspace/domain. scripts/src/complianceGateTest.ts pins the
// two against each other so drift goes red in CI.
//
// House conventions honored (audit ruling "Integer FKs, not UUID PKs"):
// serial PK + integer userId FK → users.id. reviewedBy is a plain integer
// (admin user id) like the provenance columns in masterLiveAccess.ts — not an
// enforced FK, so review provenance survives admin-account lifecycle events.
//
// MIGRATION NOTE: additive new table, no existing rows touched. Applied later
// on Replit by the owner via `pnpm --filter @workspace/db run push` (this
// workspace never runs DB commands — Replit env points at production).
//
// SECURITY: mutations only via ADMIN/OWNER routes that also write an audit row
// (same rule as user_master_live_access). This table stores NO credentials.
import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  jsonb,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// Mirrors lib/domain/src/compliance-gate ELIGIBILITY_STATUSES (see header).
export const BROKER_ELIGIBILITY_STATUSES = [
  "ELIGIBLE",
  "RESTRICTED",
  "READ_ONLY",
  "COMPLIANCE_HOLD",
  "INELIGIBLE",
] as const;
export type BrokerEligibilityStatus =
  (typeof BROKER_ELIGIBILITY_STATUSES)[number];

export const brokerEligibilityTable = pgTable(
  "broker_eligibility",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id),
    // Venue code, lowercase, matching the BrokerKind convention ("mt5",
    // "deriv", …) and the future broker catalog's venue identifiers.
    venueCode: text("venue_code").notNull(),

    // Verified legal residency (ISO country code or free-form jurisdiction as
    // captured at review time). null = not captured yet — which alone keeps
    // the row at COMPLIANCE_HOLD under honest review practice.
    legalResidency: text("legal_residency"),

    // ELIGIBLE | RESTRICTED | READ_ONLY | COMPLIANCE_HOLD | INELIGIBLE.
    // DEFAULT COMPLIANCE_HOLD — the fail-closed posture spec §1.3 demands:
    // nothing becomes tradable by row creation alone.
    eligibilityStatus: text("eligibility_status")
      .notNull()
      .default("COMPLIANCE_HOLD"),

    // §1.3 beneficial-ownership capture (audit-workspaces §4.2): who actually
    // owns the funds behind this user's venue access. null = unattested.
    beneficialOwner: text("beneficial_owner"),
    // Relationship of this user to the master/operator account, e.g. SELF /
    // SAME_ENTITY_OPERATOR / EMPLOYEE_OF_OWNER / OUTSIDE_CLIENT (vocabulary
    // enforced at the route layer; OUTSIDE_CLIENT must force COMPLIANCE_HOLD
    // until counsel + broker approval are documented — blueprint L2817).
    relationshipToMaster: text("relationship_to_master"),

    // Review provenance: which admin set the current status, and when.
    // null/null = never reviewed (status can only be the default hold).
    reviewedBy: integer("reviewed_by"),
    reviewedAt: timestamp("reviewed_at"),

    // Machine-readable reason codes explaining the current status (blueprint
    // §70 "…with reasons"). Never free-form user PII; codes only.
    reasons: jsonb("reasons").$type<string[]>().notNull().default([]),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    // Exactly one governing row per user per venue — two rows for the same
    // pair would make "which status applies?" ambiguous, and ambiguity here
    // must never resolve in the permissive direction.
    userVenueUq: uniqueIndex("broker_eligibility_user_venue_uq").on(
      t.userId,
      t.venueCode,
    ),
  }),
);

export type BrokerEligibility = typeof brokerEligibilityTable.$inferSelect;
export type NewBrokerEligibility = typeof brokerEligibilityTable.$inferInsert;

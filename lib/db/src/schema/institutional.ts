// Capability #50 — organization / legal-entity model.
//
// The institutional sub-layers already exist but were UNLINKED:
//   * strategy_pools (fundbook.ts)             — pooled strategy capital
//   * shared_master_accounts (adminTrading.ts) — the broker master account
//   * virtual_trading_accounts (adminTrading)  — per-user subaccount ledgers
//   * user_slot_allocation (userSlotAllocation)— per-user risk cells/slots
//   * security_roles / security_user_roles     — the RBAC layer
//   * broker_eligibility.beneficialOwner       — flat text attestation
//
// These three tables link them into ONE hierarchy:
//   organizations              — legal entities / orgs / desks / funds, with
//                                a parentOrgId self-reference (tree).
//   org_entity_links           — org → concrete layer object (pool, master
//                                account, virtual account, risk slot, role,
//                                user), typed by layerKind.
//   beneficial_ownership_edges — the ownership GRAPH (user-or-org → org, with
//                                percentage + control kind), replacing the
//                                flat beneficialOwner text as the structural
//                                source of truth (the text field remains as
//                                the attestation capture).
//
// The consolidated-exposure read (capability #50 → feeds capbrain #22) is
// computed by lib/domain/src/institutional + the api-server service; these
// tables carry structure only — no balances, no derived numbers.
//
// House conventions: integer PK + publicId (Owner Ruling 3); additive-only —
// this file creates new tables and touches nothing existing. Applied to the
// database via docs/migrations-pending/build-institutional.sql (this
// repository has no migration system; drizzle-kit push is broken).
import {
  pgTable,
  serial,
  integer,
  text,
  doublePrecision,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// What an organization node IS. LEGAL_ENTITY carries jurisdiction facts;
// the others are internal structure.
export const ORG_ENTITY_KINDS = [
  "LEGAL_ENTITY",
  "ORGANIZATION",
  "DESK",
  "FUND",
] as const;
export type OrgEntityKind = (typeof ORG_ENTITY_KINDS)[number];

export const organizationsTable = pgTable(
  "organizations",
  {
    id: serial("id").primaryKey(),
    publicId: text("public_id").notNull(),
    name: text("name").notNull(),
    entityKind: text("entity_kind").notNull().default("ORGANIZATION"),
    // ISO country / jurisdiction as captured at registration review; null =
    // not captured (a LEGAL_ENTITY without jurisdiction is honestly incomplete
    // and the domain roll-up flags it — never invented).
    jurisdiction: text("jurisdiction"),
    // Registration / company number as attested. Never a credential.
    registrationRef: text("registration_ref"),
    // Self-referential tree. null = root. Cycle prevention is enforced in the
    // domain layer (buildOrgHierarchy refuses cyclic input with a typed
    // error) and by the route layer refusing a parent change that creates one.
    parentOrgId: integer("parent_org_id"),
    status: text("status").notNull().default("active"), // active | dissolved | suspended
    createdByAdminId: integer("created_by_admin_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgPublicIdUq: uniqueIndex("organizations_public_id_uq").on(t.publicId),
    orgParentIdx: index("organizations_parent_idx").on(t.parentOrgId),
  }),
);
export type OrganizationRow = typeof organizationsTable.$inferSelect;

// The layer kinds an org may link. layerRefId is the integer PK in the
// owning table for that kind. The vocabulary is closed: an unknown kind is
// refused at the route AND ignored-with-typed-report by the domain roll-up
// (never silently summed).
export const ORG_LINK_LAYER_KINDS = [
  "STRATEGY_POOL",          // strategy_pools.id
  "SHARED_MASTER_ACCOUNT",  // shared_master_accounts.id
  "VIRTUAL_TRADING_ACCOUNT",// virtual_trading_accounts.id
  "USER_SLOT_ALLOCATION",   // user_slot_allocation.id (risk cell)
  "SECURITY_ROLE",          // security_roles.id
  "USER",                   // users.id
] as const;
export type OrgLinkLayerKind = (typeof ORG_LINK_LAYER_KINDS)[number];

export const orgEntityLinksTable = pgTable(
  "org_entity_links",
  {
    id: serial("id").primaryKey(),
    orgId: integer("org_id").notNull(),
    layerKind: text("layer_kind").notNull(),
    layerRefId: integer("layer_ref_id").notNull(),
    // Free-form label for the link's role in the hierarchy (e.g. "primary
    // trading account", "ops desk pool"). Optional.
    label: text("label"),
    createdByAdminId: integer("created_by_admin_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // One org may link a given object once; the SAME object may be linked by
    // at most one org (otherwise "whose exposure is this?" is ambiguous, and
    // ambiguity must never resolve permissively) — enforced by the second
    // unique index on (layerKind, layerRefId).
    orgLinkUq: uniqueIndex("org_entity_links_org_layer_uq").on(
      t.orgId, t.layerKind, t.layerRefId,
    ),
    layerObjectUq: uniqueIndex("org_entity_links_layer_object_uq").on(
      t.layerKind, t.layerRefId,
    ),
    orgIdx: index("org_entity_links_org_idx").on(t.orgId),
  }),
);
export type OrgEntityLinkRow = typeof orgEntityLinksTable.$inferSelect;

export const OWNERSHIP_OWNER_KINDS = ["USER", "ORG"] as const;
export type OwnershipOwnerKind = (typeof OWNERSHIP_OWNER_KINDS)[number];

export const OWNERSHIP_CONTROL_KINDS = [
  "BENEFICIAL_OWNER",
  "CONTROLLER",
  "NOMINEE",
  "TRUSTEE",
] as const;
export type OwnershipControlKind = (typeof OWNERSHIP_CONTROL_KINDS)[number];

export const beneficialOwnershipEdgesTable = pgTable(
  "beneficial_ownership_edges",
  {
    id: serial("id").primaryKey(),
    // The owner side: a user (users.id) or another org (organizations.id).
    ownerKind: text("owner_kind").notNull(),
    ownerRefId: integer("owner_ref_id").notNull(),
    // The owned org.
    ownedOrgId: integer("owned_org_id").notNull(),
    // Percentage in [0, 100] as attested. null = attested control WITHOUT a
    // stated percentage (e.g. CONTROLLER). Never defaulted to a number.
    ownershipPct: doublePrecision("ownership_pct"),
    controlKind: text("control_kind").notNull().default("BENEFICIAL_OWNER"),
    // Attestation provenance (admin user id + when). Like broker_eligibility
    // reviewedBy: plain integer, not an enforced FK.
    attestedBy: integer("attested_by"),
    attestedAt: timestamp("attested_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    ownershipEdgeUq: uniqueIndex("beneficial_ownership_edge_uq").on(
      t.ownerKind, t.ownerRefId, t.ownedOrgId, t.controlKind,
    ),
    ownedOrgIdx: index("beneficial_ownership_owned_idx").on(t.ownedOrgId),
  }),
);
export type BeneficialOwnershipEdgeRow =
  typeof beneficialOwnershipEdgesTable.$inferSelect;

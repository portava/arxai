-- Capability #50 — organization / legal-entity model (branch build/institutional).
--
-- ADDITIVE ONLY. Creates three new tables and nothing else: no ALTER, no DROP,
-- no data migration. Safe to run repeatedly (IF NOT EXISTS throughout).
-- Applied by the owner on Replit (this repository has no migration system and
-- drizzle-kit push is broken — see CLAUDE.md "Schema changes").
--
-- Drizzle source of truth: lib/db/src/schema/institutional.ts.

-- Legal entities / organizations / desks / funds, as a parent-linked tree.
CREATE TABLE IF NOT EXISTS organizations (
  id                  SERIAL PRIMARY KEY,
  public_id           TEXT NOT NULL,
  name                TEXT NOT NULL,
  entity_kind         TEXT NOT NULL DEFAULT 'ORGANIZATION',
  jurisdiction        TEXT,
  registration_ref    TEXT,
  parent_org_id       INTEGER,
  status              TEXT NOT NULL DEFAULT 'active',
  created_by_admin_id INTEGER,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS organizations_public_id_uq ON organizations (public_id);
CREATE INDEX IF NOT EXISTS organizations_parent_idx ON organizations (parent_org_id);

-- Org → concrete layer object (pool / master account / virtual account /
-- risk slot / security role / user). One object belongs to at most ONE org.
CREATE TABLE IF NOT EXISTS org_entity_links (
  id                  SERIAL PRIMARY KEY,
  org_id              INTEGER NOT NULL,
  layer_kind          TEXT NOT NULL,
  layer_ref_id        INTEGER NOT NULL,
  label               TEXT,
  created_by_admin_id INTEGER,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS org_entity_links_org_layer_uq
  ON org_entity_links (org_id, layer_kind, layer_ref_id);
CREATE UNIQUE INDEX IF NOT EXISTS org_entity_links_layer_object_uq
  ON org_entity_links (layer_kind, layer_ref_id);
CREATE INDEX IF NOT EXISTS org_entity_links_org_idx ON org_entity_links (org_id);

-- Beneficial-ownership graph: (user|org) → org with percentage + control kind.
CREATE TABLE IF NOT EXISTS beneficial_ownership_edges (
  id            SERIAL PRIMARY KEY,
  owner_kind    TEXT NOT NULL,
  owner_ref_id  INTEGER NOT NULL,
  owned_org_id  INTEGER NOT NULL,
  ownership_pct DOUBLE PRECISION,
  control_kind  TEXT NOT NULL DEFAULT 'BENEFICIAL_OWNER',
  attested_by   INTEGER,
  attested_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS beneficial_ownership_edge_uq
  ON beneficial_ownership_edges (owner_kind, owner_ref_id, owned_org_id, control_kind);
CREATE INDEX IF NOT EXISTS beneficial_ownership_owned_idx
  ON beneficial_ownership_edges (owned_org_id);

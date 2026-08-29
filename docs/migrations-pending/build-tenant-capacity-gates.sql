-- Tenant-context plane + edge-capacity governor (branch build/tenant-capacity-gates)
-- — additive schema for foundation gate #23 EDGE_CAPACITY_EXCEEDED.
--
-- Apply with raw psql (drizzle-kit push is broken against the dev DB —
-- pre-existing broker_hub drift). Every statement is IF NOT EXISTS and
-- additive; nothing is dropped or altered destructively.
--
-- Gate #22 TENANT_CONTEXT_VIOLATION needs NO schema: the tenant-ownership
-- stamps are derived at dispatch time from reads that already exist.
--
-- production_edges capacity columns (all nullable; NULL capacity_status means
-- "no estimate recorded" and gate #23 refuses capacity-governed LIVE entries):

ALTER TABLE production_edges
  ADD COLUMN IF NOT EXISTS capacity_status text;
ALTER TABLE production_edges
  ADD COLUMN IF NOT EXISTS capacity_risk_r double precision;
ALTER TABLE production_edges
  ADD COLUMN IF NOT EXISTS capacity_max_deployed_usd double precision;
ALTER TABLE production_edges
  ADD COLUMN IF NOT EXISTS capacity_deploy_cap_override_usd double precision;
ALTER TABLE production_edges
  ADD COLUMN IF NOT EXISTS capacity_evidence_json jsonb;
ALTER TABLE production_edges
  ADD COLUMN IF NOT EXISTS capacity_estimated_at timestamptz;
ALTER TABLE production_edges
  ADD COLUMN IF NOT EXISTS capacity_recorded_by_admin_id integer;

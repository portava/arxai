-- Governance closure (branch build/governance-closure) — additive schema.
-- Apply with raw psql (drizzle-kit push is broken against the dev DB —
-- pre-existing broker_hub drift). Every statement is IF NOT EXISTS / additive;
-- nothing is dropped, rewritten, or backfilled.
--
-- #54 Owner Decision Registry — review-date field.
-- Nullable: pre-existing rulings read as null (their review dates were never
-- recorded — honest UNKNOWN). The append-only discipline is unchanged: a
-- review re-affirms via a new append or an updated date in the CI linkage
-- registry (scripts/src/ci/check-owner-decision-linkage.ts), never an UPDATE.
ALTER TABLE owner_decisions
  ADD COLUMN IF NOT EXISTS review_by_date timestamptz;

-- #56 / #59 need no schema: certification review periods are a coded register
-- (lib/domain/src/safety-contracts/certificationExpiry.ts), and the
-- minimum-intelligence baseline writes through the EXISTING shadow_predictions
-- and champion_challenger_pairs tables (compose, don't duplicate — Ruling 4).

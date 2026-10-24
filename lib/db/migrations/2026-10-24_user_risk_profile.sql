-- Per-user risk profile (presets and prop-firm mode), replacing the old
-- in-memory global "Risk Governor 2.0" profile.
--
-- Additive and idempotent. Both columns are nullable: existing rows keep
-- exactly today's limits. Applying a preset or a prop-firm setup writes into
-- the trader's existing limit columns, which the pre-trade Risk Governor
-- already reads (strictest of trader, admin and platform wins).
--
-- Rollback (only if no trader has applied a preset yet; it drops that record,
-- never a limit):
--   ALTER TABLE user_risk_settings DROP COLUMN IF EXISTS risk_preset;
--   ALTER TABLE user_risk_settings DROP COLUMN IF EXISTS prop_firm;

ALTER TABLE user_risk_settings ADD COLUMN IF NOT EXISTS risk_preset text;
ALTER TABLE user_risk_settings ADD COLUMN IF NOT EXISTS prop_firm jsonb;

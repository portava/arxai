-- Resilience front (branch build/resilience) — additive schema.
-- Apply with raw psql (drizzle-kit push is broken against the dev DB —
-- pre-existing broker_hub drift). Every statement is IF NOT EXISTS and
-- additive; nothing is dropped or altered destructively.
--
-- Tables:
--   #27 execution_policy_promotions — promotion-gate state for the shadow
--       execution-policy chooser. Automatic writers only ever record
--       SHADOW/PRESS_UNLOCKED; ENABLED is written only by the owner-press
--       admin seam.

CREATE TABLE IF NOT EXISTS execution_policy_promotions (
  id                serial PRIMARY KEY,
  scope             text NOT NULL DEFAULT 'platform',
  status            text NOT NULL DEFAULT 'SHADOW',
  status_entered_at timestamptz NOT NULL,
  evidence_json     jsonb,
  history_json      jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS execution_policy_promotions_scope_idx
  ON execution_policy_promotions (scope);

-- OPTIONAL (owner decision, documented in docs/WATCHDOG.md — do NOT apply as
-- part of this migration): a dedicated read-only role for the independent
-- protection watchdog (#28). The watchdog also self-enforces read-only via
-- "SET default_transaction_read_only = on" on its own connection, so this
-- role is defense-in-depth for a separate-host deployment.
--
--   CREATE ROLE arx_watchdog_ro LOGIN PASSWORD '<set-by-owner>';
--   GRANT CONNECT ON DATABASE <dbname> TO arx_watchdog_ro;
--   GRANT USAGE ON SCHEMA public TO arx_watchdog_ro;
--   GRANT SELECT ON live_positions, mt5_commands, safety_core,
--     system_health_checks, audit_events TO arx_watchdog_ro;

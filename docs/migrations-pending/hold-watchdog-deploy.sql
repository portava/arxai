-- HOLD 5 — Independent Protection Watchdog deployment (branch hold/watchdog-deploy).
-- Additive schema. Every statement is IF NOT EXISTS; nothing is dropped or
-- altered destructively. Apply with raw psql (drizzle-kit push is NOT used in
-- this repository — see CLAUDE.md §"Schema changes").
--
-- Table:
--   watchdog_heartbeats — one row per deployed watchdog instance, upserted by
--   the API server when the watchdog POSTs a pass to /api/watchdog/alerts.
--   The watchdog process itself runs a forced read-only session and can never
--   write this row; that asymmetry is the point (capability #28).
--
-- Contains no secret column. The shared ingest token lives only in the
-- environment of both processes and is never persisted.

CREATE TABLE IF NOT EXISTS watchdog_heartbeats (
  id                        serial PRIMARY KEY,
  instance_id               text NOT NULL,
  topology                  text NOT NULL DEFAULT 'unknown',
  last_verdict              text NOT NULL,
  last_seen_at              timestamptz NOT NULL,
  findings_total            integer NOT NULL DEFAULT 0,
  critical_count            integer NOT NULL DEFAULT 0,
  cannot_verify_count       integer NOT NULL DEFAULT 0,
  active_finding_keys       jsonb NOT NULL DEFAULT '[]'::jsonb,
  watchdog_uptime_seconds   integer NOT NULL DEFAULT 0,
  notifications_raised      integer NOT NULL DEFAULT 0,
  ingest_degraded           boolean NOT NULL DEFAULT false,
  ingest_degraded_reason    text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS watchdog_heartbeats_instance_id_idx
  ON watchdog_heartbeats (instance_id);
CREATE INDEX IF NOT EXISTS watchdog_heartbeats_last_seen_at_idx
  ON watchdog_heartbeats (last_seen_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- OPTIONAL, OWNER-APPLIED, DELIBERATELY NOT PART OF THIS MIGRATION:
-- a dedicated read-only role for the watchdog. The process already self-enforces
-- read-only ("SET default_transaction_read_only = on" on its own session), so
-- this role is defence in depth for topology (b)/(c) where the connection
-- string leaves the app host.
--
-- This agent may NOT create or rotate a credential. The owner runs these,
-- choosing the password themselves:
--
--   CREATE ROLE arx_watchdog_ro LOGIN PASSWORD '<chosen-by-owner>';
--   GRANT CONNECT ON DATABASE <dbname> TO arx_watchdog_ro;
--   GRANT USAGE ON SCHEMA public TO arx_watchdog_ro;
--   GRANT SELECT ON live_positions, mt5_commands, safety_core,
--     system_health_checks, audit_events TO arx_watchdog_ro;
--
-- Verify the role really is read-only before trusting it:
--   psql "<arx_watchdog_ro url>" -c "CREATE TABLE _wd_probe(x int);"   -- must ERROR
--   psql "<arx_watchdog_ro url>" -c "SELECT count(*) FROM live_positions;" -- must succeed

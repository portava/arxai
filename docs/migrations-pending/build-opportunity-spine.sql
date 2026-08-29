-- Opportunity Spine (branch build/opportunity-spine) — additive schema.
-- Apply with raw psql (drizzle-kit push is broken against the dev DB —
-- pre-existing broker_hub drift). Every statement is IF NOT EXISTS and
-- additive; nothing is dropped or altered destructively.
--
-- Tables:
--   #17 opportunities        — owning per-setup lifecycle objects with terminal
--                              EXECUTED/REJECTED/MISSED/EXPIRED/INVALIDATED
--   #17 opportunity_events   — unified append-only per-opportunity event log
--                              (full reconstruction via replayOpportunity)

CREATE TABLE IF NOT EXISTS opportunities (
  id                  serial PRIMARY KEY,
  opportunity_key     text NOT NULL,
  symbol              text NOT NULL,
  timeframe           text NOT NULL,
  horizon_class       text NOT NULL DEFAULT 'UNKNOWN',
  side                text NOT NULL,
  setup_type          text NOT NULL,
  state               text NOT NULL DEFAULT 'WATCHING',
  entry_window_seen   boolean NOT NULL DEFAULT false,
  execution_attempted boolean NOT NULL DEFAULT false,
  owner_agent_key     text,
  best_rank_score     double precision NOT NULL DEFAULT 0,
  last_cycle_id       text,
  thesis              jsonb,
  setup_expires_at    timestamptz,
  first_seen_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  terminal_at         timestamptz,
  terminal_reason     text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- One OPEN object per setup identity; terminal rows free the key (a fresh
-- sighting after termination creates a NEW object — no revival).
CREATE UNIQUE INDEX IF NOT EXISTS opportunities_open_key_uq
  ON opportunities (opportunity_key) WHERE terminal_at IS NULL;
CREATE INDEX IF NOT EXISTS opportunities_state_idx ON opportunities (state);
CREATE INDEX IF NOT EXISTS opportunities_symbol_idx ON opportunities (symbol);
CREATE INDEX IF NOT EXISTS opportunities_last_seen_idx ON opportunities (last_seen_at);

CREATE TABLE IF NOT EXISTS opportunity_events (
  id             serial PRIMARY KEY,
  opportunity_id integer NOT NULL,
  event_type     text NOT NULL,
  from_state     text,
  to_state       text,
  reason         text NOT NULL,
  cycle_id       text,
  decision_id    integer,
  agent_key      text,
  payload        jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS opportunity_events_opportunity_idx
  ON opportunity_events (opportunity_id, id);
CREATE INDEX IF NOT EXISTS opportunity_events_type_idx
  ON opportunity_events (event_type);

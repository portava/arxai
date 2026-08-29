-- build/product-polish — additive schema for capabilities #37, #42, #44, #45.
-- Apply with plain psql. Everything is IF NOT EXISTS / additive; nothing is
-- dropped, narrowed, or rewritten. Safe to re-run.

-- ── #37 unified owner-grantable authority ledger ────────────────────────────
CREATE TABLE IF NOT EXISTS authority_grants (
  id                  serial PRIMARY KEY,
  public_id           text NOT NULL,
  user_id             integer NOT NULL,
  kind                text NOT NULL,
  scope_type          text NOT NULL,
  scope_ref           text,
  max_level           integer NOT NULL,
  reason              text,
  granted_by_user_id  integer NOT NULL,
  granted_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  revoked_at          timestamptz,
  revoked_by_user_id  integer,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS authority_grants_user_kind_idx ON authority_grants (user_id, kind);
CREATE INDEX IF NOT EXISTS authority_grants_expires_at_idx ON authority_grants (expires_at);

-- ── #42 delayed risk-ceiling increases ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS risk_pending_increases (
  id             serial PRIMARY KEY,
  user_id        integer NOT NULL,
  field          text NOT NULL,
  value_kind     text NOT NULL DEFAULT 'number',
  current_value  real NOT NULL,
  target_value   real NOT NULL,
  direction      text NOT NULL DEFAULT 'LOOSEN',
  status         text NOT NULL DEFAULT 'PENDING',
  requested_at   timestamptz NOT NULL DEFAULT now(),
  effective_at   timestamptz NOT NULL,
  confirmed_at   timestamptz,
  cancelled_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS risk_pending_increases_user_status_idx ON risk_pending_increases (user_id, status);

-- ── #44 manual takeover state on arx_live_positions ─────────────────────────
ALTER TABLE arx_live_positions ADD COLUMN IF NOT EXISTS management_state text NOT NULL DEFAULT 'STRATEGY_MANAGED';
ALTER TABLE arx_live_positions ADD COLUMN IF NOT EXISTS manual_takeover_at timestamptz;
ALTER TABLE arx_live_positions ADD COLUMN IF NOT EXISTS manual_takeover_reason text;
ALTER TABLE arx_live_positions ADD COLUMN IF NOT EXISTS manual_release_at timestamptz;

-- ── #45 origin-class attribution on trades ──────────────────────────────────
ALTER TABLE trades ADD COLUMN IF NOT EXISTS origin_class text;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS origin_class_source text;

-- branch build/flywheel-machinery — THE LEARNING FLYWHEEL (B0–B7), SHADOW-ONLY.
-- Additive only. Apply via raw psql (drizzle-kit push is broken against the
-- dev DB — pre-existing broker_hub drift). Idempotent: IF NOT EXISTS on
-- every statement.
--
-- SAFETY: none of these tables is consulted by any gate, floor, stop, sizing,
-- or dispatch path. flywheel_allocation_journal and flywheel_ope_reports are
-- APPEND-ONLY (enforced by scripts/src/ci/check-vault-mutations.ts, not ACL).
-- flywheel_cohort_outcomes carries NO user identity by design (B7 privacy).

-- B0 — per-trade case files (before/during/after evidence, provenance-stamped)
CREATE TABLE IF NOT EXISTS flywheel_case_files (
  id               SERIAL PRIMARY KEY,
  case_id          TEXT NOT NULL,
  user_id          INTEGER NOT NULL,
  mission_id       INTEGER,
  strategy_id      TEXT NOT NULL,
  symbol           TEXT NOT NULL,
  direction        TEXT NOT NULL,
  regime_label     TEXT NOT NULL DEFAULT 'UNKNOWN',
  phase            TEXT NOT NULL DEFAULT 'DRAFTED',
  before_json      JSONB NOT NULL DEFAULT '{}'::jsonb,
  during_json      JSONB NOT NULL DEFAULT '{}'::jsonb,
  after_json       JSONB NOT NULL DEFAULT '{}'::jsonb,
  provenance_json  JSONB NOT NULL DEFAULT '{}'::jsonb,
  completeness     TEXT NOT NULL DEFAULT 'PARTIAL',
  missing_json     JSONB NOT NULL DEFAULT '[]'::jsonb,
  command_id       TEXT,
  broker_ticket    TEXT,
  ledger           TEXT,
  assembled_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS flywheel_case_files_case_ux ON flywheel_case_files (case_id);
CREATE INDEX IF NOT EXISTS flywheel_case_files_user_idx ON flywheel_case_files (user_id);
CREATE INDEX IF NOT EXISTS flywheel_case_files_phase_idx ON flywheel_case_files (phase);
CREATE INDEX IF NOT EXISTS flywheel_case_files_strategy_idx ON flywheel_case_files (strategy_id);

-- B1 — broker-reconciled net log-return rewards (UNRECONCILED = excluded)
CREATE TABLE IF NOT EXISTS flywheel_rewards (
  id                SERIAL PRIMARY KEY,
  reward_id         TEXT NOT NULL,
  case_id           TEXT NOT NULL,
  user_id           INTEGER NOT NULL,
  ledger            TEXT NOT NULL,
  strategy_id       TEXT NOT NULL,
  regime_label      TEXT NOT NULL DEFAULT 'UNKNOWN',
  instrument        TEXT NOT NULL,
  status            TEXT NOT NULL,
  net_log_return    DOUBLE PRECISION,
  net_pnl_minor     BIGINT,
  equity_base_minor BIGINT,
  currency          TEXT,
  scale             INTEGER,
  journal_ids_json  JSONB NOT NULL DEFAULT '[]'::jsonb,
  reasons_json      JSONB NOT NULL DEFAULT '[]'::jsonb,
  computed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS flywheel_rewards_reward_ux ON flywheel_rewards (reward_id);
CREATE INDEX IF NOT EXISTS flywheel_rewards_cohort_idx ON flywheel_rewards (strategy_id, regime_label, instrument);
CREATE INDEX IF NOT EXISTS flywheel_rewards_status_idx ON flywheel_rewards (status);
CREATE INDEX IF NOT EXISTS flywheel_rewards_user_idx ON flywheel_rewards (user_id);

-- B2 — Normal-Inverse-Gamma posteriors per strategy × regime × instrument
CREATE TABLE IF NOT EXISTS flywheel_posteriors (
  id            SERIAL PRIMARY KEY,
  cohort_key    TEXT NOT NULL,
  strategy_id   TEXT NOT NULL,
  regime_label  TEXT NOT NULL,
  instrument    TEXT NOT NULL,
  mu            DOUBLE PRECISION NOT NULL,
  kappa         DOUBLE PRECISION NOT NULL,
  alpha         DOUBLE PRECISION NOT NULL,
  beta          DOUBLE PRECISION NOT NULL,
  sample_count  INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS flywheel_posteriors_cohort_ux ON flywheel_posteriors (cohort_key);
CREATE INDEX IF NOT EXISTS flywheel_posteriors_strategy_idx ON flywheel_posteriors (strategy_id);

-- B3 — SHADOW allocation journal (APPEND-ONLY: records, never instructions)
CREATE TABLE IF NOT EXISTS flywheel_allocation_journal (
  id              SERIAL PRIMARY KEY,
  pass_id         TEXT NOT NULL,
  mode            TEXT NOT NULL DEFAULT 'SHADOW',
  authority       TEXT NOT NULL DEFAULT 'NONE',
  weights_json    JSONB NOT NULL,
  clamp_json      JSONB NOT NULL DEFAULT '{}'::jsonb,
  decay_json      JSONB NOT NULL DEFAULT '[]'::jsonb,
  posteriors_used INTEGER NOT NULL DEFAULT 0,
  computed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS flywheel_allocation_journal_pass_idx ON flywheel_allocation_journal (pass_id);
CREATE INDEX IF NOT EXISTS flywheel_allocation_journal_computed_idx ON flywheel_allocation_journal (computed_at);

-- B6 — off-policy evaluation reports over declined drafts (APPEND-ONLY, advisory)
CREATE TABLE IF NOT EXISTS flywheel_ope_reports (
  id            SERIAL PRIMARY KEY,
  report_id     TEXT NOT NULL,
  pass_id       TEXT NOT NULL,
  scope         TEXT NOT NULL,
  advisory      BOOLEAN NOT NULL DEFAULT TRUE,
  estimate_json JSONB NOT NULL,
  records_json  JSONB NOT NULL DEFAULT '[]'::jsonb,
  reasons_json  JSONB NOT NULL DEFAULT '[]'::jsonb,
  computed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS flywheel_ope_reports_report_ux ON flywheel_ope_reports (report_id);
CREATE INDEX IF NOT EXISTS flywheel_ope_reports_pass_idx ON flywheel_ope_reports (pass_id);

-- B7 — anonymized cross-tenant cohort outcome ledger (NO user identity)
CREATE TABLE IF NOT EXISTS flywheel_cohort_outcomes (
  id                  SERIAL PRIMARY KEY,
  cohort_key          TEXT NOT NULL,
  strategy_id         TEXT NOT NULL,
  regime_label        TEXT NOT NULL,
  instrument          TEXT NOT NULL,
  contributor_count   INTEGER NOT NULL DEFAULT 0,
  sample_count        INTEGER NOT NULL DEFAULT 0,
  mean_net_log_return DOUBLE PRECISION,
  var_net_log_return  DOUBLE PRECISION,
  is_surfaceable      BOOLEAN NOT NULL DEFAULT FALSE,
  last_aggregated_at  TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS flywheel_cohort_outcomes_cohort_ux ON flywheel_cohort_outcomes (cohort_key);
CREATE INDEX IF NOT EXISTS flywheel_cohort_outcomes_surface_idx ON flywheel_cohort_outcomes (is_surfaceable);

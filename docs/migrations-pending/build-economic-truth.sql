-- branch build/economic-truth — Economic Truth Spine (#29/#30/#31)
-- Additive only. Apply via raw psql (drizzle-kit push is broken against the
-- dev DB — pre-existing broker_hub drift). Idempotent: IF NOT EXISTS on
-- every statement.
--
-- APPEND-ONLY tables: no application code may UPDATE or DELETE rows here
-- (enforced by scripts/src/ci/check-vault-mutations.ts, not by ACL — the app
-- connects as superuser). Corrections are reverse-and-repost journals.

CREATE TABLE IF NOT EXISTS economic_postings (
  id                    BIGSERIAL PRIMARY KEY,
  journal_id            TEXT NOT NULL,
  leg_index             INTEGER NOT NULL,
  user_id               INTEGER NOT NULL,
  ledger                TEXT NOT NULL,
  account               TEXT NOT NULL,
  strategy_id           TEXT,
  amount_minor          BIGINT NOT NULL,
  currency              TEXT NOT NULL,
  scale                 INTEGER NOT NULL,
  value_unknown         BOOLEAN NOT NULL DEFAULT FALSE,
  kind                  TEXT NOT NULL,
  source                TEXT NOT NULL,
  effective_at          TIMESTAMPTZ NOT NULL,
  known_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  command_id            TEXT,
  broker_ticket         TEXT,
  reverses_journal_id   TEXT,
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS economic_postings_journal_leg_uq
  ON economic_postings (journal_id, leg_index);
CREATE INDEX IF NOT EXISTS economic_postings_user_ledger_idx
  ON economic_postings (user_id, ledger);
CREATE INDEX IF NOT EXISTS economic_postings_account_idx
  ON economic_postings (account);
CREATE INDEX IF NOT EXISTS economic_postings_command_idx
  ON economic_postings (command_id);

CREATE TABLE IF NOT EXISTS economic_discrepancies (
  id                    BIGSERIAL PRIMARY KEY,
  user_id               INTEGER NOT NULL,
  ledger                TEXT NOT NULL,
  verdict               TEXT NOT NULL,
  broker_balance_minor  BIGINT,
  ledger_cash_minor     BIGINT NOT NULL,
  baseline_minor        BIGINT,
  difference_minor      BIGINT,
  currency              TEXT NOT NULL,
  scale                 INTEGER NOT NULL,
  broker_source         TEXT,
  truth_winner          TEXT,
  reason                TEXT NOT NULL,
  trigger               TEXT NOT NULL,
  observed_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS economic_discrepancies_user_ledger_idx
  ON economic_discrepancies (user_id, ledger);
CREATE INDEX IF NOT EXISTS economic_discrepancies_verdict_idx
  ON economic_discrepancies (verdict);

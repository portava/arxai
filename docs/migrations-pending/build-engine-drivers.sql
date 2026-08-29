-- Engine Drivers (branch build/engine-drivers) — additive schema.
-- Apply with raw psql (drizzle-kit push is broken against the dev DB —
-- pre-existing broker_hub drift). Every statement is IF NOT EXISTS and
-- additive; nothing is dropped or altered destructively.
--
-- Tables:
--   #58 intelligence_roi_records / intelligence_roi_passes
--   #34 recovery_probations
--   #15 champion_challenger_pairs
--   #16 meta_strategy_states
--   #5  mission_draft_counterfactuals

CREATE TABLE IF NOT EXISTS intelligence_roi_records (
  id                    serial PRIMARY KEY,
  component_key         text NOT NULL,
  window_start          timestamptz NOT NULL,
  window_end            timestamptz NOT NULL,
  decisions_observed    integer NOT NULL DEFAULT 0,
  decisions_contributed integer NOT NULL DEFAULT 0,
  closed_trades         integer NOT NULL DEFAULT 0,
  realized_pnl_usd      double precision,
  captured_profit_usd   double precision,
  profits_missed_usd    double precision,
  losses_avoided_usd    double precision,
  losses_avoided_basis  text,
  cost_cpu_ms           double precision,
  cost_basis            text,
  error_rate_01         real,
  reasons_json          jsonb,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS intelligence_roi_records_component_window_idx
  ON intelligence_roi_records (component_key, window_end);
CREATE INDEX IF NOT EXISTS intelligence_roi_records_window_end_idx
  ON intelligence_roi_records (window_end);

CREATE TABLE IF NOT EXISTS intelligence_roi_passes (
  id                  serial PRIMARY KEY,
  ran_at              timestamptz NOT NULL DEFAULT now(),
  window_start        timestamptz NOT NULL,
  window_end          timestamptz NOT NULL,
  components_examined integer NOT NULL DEFAULT 0,
  verdict_json        jsonb NOT NULL,
  reasons_json        jsonb
);
CREATE INDEX IF NOT EXISTS intelligence_roi_passes_ran_at_idx
  ON intelligence_roi_passes (ran_at);

CREATE TABLE IF NOT EXISTS recovery_probations (
  id               serial PRIMARY KEY,
  scope            text NOT NULL DEFAULT 'platform',
  status           text NOT NULL DEFAULT 'active',
  stage            text NOT NULL,
  stage_entered_at timestamptz NOT NULL,
  source           text NOT NULL,
  reasons_json     jsonb,
  history_json     jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recovery_probations_scope_status_idx
  ON recovery_probations (scope, status);

CREATE TABLE IF NOT EXISTS champion_challenger_pairs (
  id                   serial PRIMARY KEY,
  pair_id              text NOT NULL,
  draft_id             text NOT NULL,
  challenger_shadow_id text NOT NULL,
  challenger_strategy  text NOT NULL,
  symbol               text NOT NULL,
  champion_json        jsonb NOT NULL,
  challenger_json      jsonb NOT NULL,
  comparison_class     text NOT NULL,
  judgment             text NOT NULL,
  champion_pnl_r       double precision,
  challenger_pnl_r     double precision,
  challenger_edge_r    double precision,
  reasons_json         jsonb,
  paired_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS champion_challenger_pairs_pair_ux
  ON champion_challenger_pairs (draft_id, challenger_shadow_id);
CREATE INDEX IF NOT EXISTS champion_challenger_pairs_strategy_idx
  ON champion_challenger_pairs (challenger_strategy);
CREATE INDEX IF NOT EXISTS champion_challenger_pairs_paired_at_idx
  ON champion_challenger_pairs (paired_at);

CREATE TABLE IF NOT EXISTS meta_strategy_states (
  id                serial PRIMARY KEY,
  strategy          text NOT NULL,
  applied_state     text NOT NULL,
  recommended_state text,
  reasons_json      jsonb,
  evidence_json     jsonb,
  history_json      jsonb,
  last_evaluated_at timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS meta_strategy_states_strategy_ux
  ON meta_strategy_states (strategy);

CREATE TABLE IF NOT EXISTS mission_draft_counterfactuals (
  id             serial PRIMARY KEY,
  draft_id       text NOT NULL,
  mission_id     integer NOT NULL,
  user_id        integer NOT NULL,
  scenarios_json jsonb NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS mission_draft_counterfactuals_draft_ux
  ON mission_draft_counterfactuals (draft_id);
CREATE INDEX IF NOT EXISTS mission_draft_counterfactuals_mission_idx
  ON mission_draft_counterfactuals (mission_id);

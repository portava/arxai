-- fix/app-B — per-user isolation on the nine non-/me routers.
--
-- NO SCHEMA CHANGE IS REQUIRED BY THAT FIX. Every table it now filters
-- (ai_mentor_sessions, mentor_action_items, trader_skill_profiles,
-- skill_level_history, edge_discovery_reports, edge_warnings,
-- weekly_performance_reviews, weekly_improvement_goals, analytics_snapshots,
-- analytics_heatmaps, user_onboarding_progress, paper_sessions, risk_settings,
-- trader_coach_reports, …) ALREADY carries a nullable `user_id` column that the
-- code simply never wrote or filtered on. This file is additive INDEXES only,
-- so those predicates do not turn every read into a sequential scan.
--
-- Additive and idempotent: CREATE INDEX IF NOT EXISTS only. No column is
-- added, dropped, renamed or retyped; no index is dropped; no data is written.
-- Safe to run more than once and safe to run before the code lands.

CREATE INDEX IF NOT EXISTS ai_mentor_sessions_user_idx        ON ai_mentor_sessions (user_id);
CREATE INDEX IF NOT EXISTS mentor_action_items_user_idx       ON mentor_action_items (user_id);
CREATE INDEX IF NOT EXISTS trader_skill_profiles_user_idx     ON trader_skill_profiles (user_id);
CREATE INDEX IF NOT EXISTS skill_level_history_user_idx       ON skill_level_history (user_id);
CREATE INDEX IF NOT EXISTS edge_discovery_reports_user_idx    ON edge_discovery_reports (user_id);
CREATE INDEX IF NOT EXISTS edge_warnings_user_idx             ON edge_warnings (user_id);
CREATE INDEX IF NOT EXISTS weekly_improvement_goals_user_idx  ON weekly_improvement_goals (user_id);
CREATE INDEX IF NOT EXISTS analytics_snapshots_user_idx       ON analytics_snapshots (user_id);
CREATE INDEX IF NOT EXISTS analytics_heatmaps_user_idx        ON analytics_heatmaps (user_id);
CREATE INDEX IF NOT EXISTS paper_orders_user_idx              ON paper_orders (user_id);
CREATE INDEX IF NOT EXISTS post_trade_debriefs_user_idx       ON post_trade_debriefs (user_id);
CREATE INDEX IF NOT EXISTS trader_coach_reports_user_idx      ON trader_coach_reports (user_id);
CREATE INDEX IF NOT EXISTS strategy_edges_user_idx            ON strategy_edges (user_id);
CREATE INDEX IF NOT EXISTS mistake_patterns_user_idx          ON mistake_patterns (user_id);
CREATE INDEX IF NOT EXISTS learning_events_user_idx           ON learning_events (user_id);
CREATE INDEX IF NOT EXISTS trade_decision_logs_user_idx       ON trade_decision_logs (user_id);
CREATE INDEX IF NOT EXISTS autopilot_cycles_user_idx          ON autopilot_cycles (user_id);
CREATE INDEX IF NOT EXISTS trading_rule_contracts_user_idx    ON trading_rule_contracts (user_id);
CREATE INDEX IF NOT EXISTS trading_rule_violations_user_idx   ON trading_rule_violations (user_id);
CREATE INDEX IF NOT EXISTS trading_readiness_checks_user_idx  ON trading_readiness_checks (user_id);
CREATE INDEX IF NOT EXISTS trade_plans_user_idx               ON trade_plans (user_id);
CREATE INDEX IF NOT EXISTS trade_journal_entries_user_idx     ON trade_journal_entries (user_id);
CREATE INDEX IF NOT EXISTS live_positions_user_idx            ON live_positions (user_id);
CREATE INDEX IF NOT EXISTS risk_locks_user_idx                ON risk_locks (user_id);
CREATE INDEX IF NOT EXISTS paper_accounts_user_idx            ON paper_accounts (user_id);

-- Tag lookup for the tester demo-seed rows that /tester-data/clear now deletes.
CREATE INDEX IF NOT EXISTS trade_journal_strategy_idx         ON trade_journal (strategy);

-- ── Review round: sibling routers the first pass did not cover ─────────────
-- Same story — the columns already exist and were simply never written or
-- filtered on. paper_executions and session_commitments are now written with
-- their owner and read with an owner predicate; trade_journal is filtered by
-- user_id in Trader Skill.
CREATE INDEX IF NOT EXISTS paper_executions_user_idx          ON paper_executions (user_id);
CREATE INDEX IF NOT EXISTS session_commitments_user_idx       ON session_commitments (user_id);
CREATE INDEX IF NOT EXISTS trade_journal_user_idx             ON trade_journal (user_id);


-- ── KNOWN LIMITS THIS FILE DOES NOT PAPER OVER ──────────────────────────────
--
-- Three tables have NO user_id column at all, so per-user rows are impossible
-- in them today. The code does NOT pretend otherwise — it withholds the claim
-- and says so on the surface — but the honest long-term fix is a schema change
-- that is NOT additive (each needs its unique key moved), which is why it is
-- deliberately not attempted here:
--
--   * performance_symbol_snapshots — UNIQUE (symbol, range_key).
--     Consumed by the Trader Coach for "your best/worst symbol". Now withheld
--     (lib/traderCoach/coach.ts, INSTANCE_WIDE_SOURCES_WITHHELD).
--   * ai_performance_snapshots     — UNIQUE (range_key). Same treatment.
--   * weekly_improvement_plans     — UNIQUE (week_start): one plan per week for
--     the WHOLE platform. The per-user weekly plan is therefore computed and
--     returned live but never persisted, and the response says so
--     (lib/traderCoach/weekly.ts, `persisted:false` + `persistenceNote`).
--   * trading_playbook_entries     — UNIQUE (symbol, setup_name, action_bias):
--     a shared setup library. Left instance-wide and now LABELLED as such
--     (`scope: "INSTANCE_WIDE"`), rather than presented as personal.
--
-- Making any of these per-user requires dropping and recreating a unique index,
-- which is a destructive migration and out of scope for this branch.

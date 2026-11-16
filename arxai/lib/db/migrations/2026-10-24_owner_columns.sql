-- Tier 1 step 10 — owners on the last three shared tables.
--
-- Additive and idempotent. Existing rows keep user_id NULL (legacy,
-- single-tenant); no reader returns them. To hand them to a user, run
--   pnpm --filter @workspace/api-server run claim:legacy-behavior-rows -- --user-id <id> [--apply]
-- with the owner named explicitly (or ARX_LEGACY_OWNER_USER_ID set). Nothing
-- here guesses an owner.

ALTER TABLE weekly_improvement_plans ADD COLUMN IF NOT EXISTS user_id integer REFERENCES users(id) ON DELETE CASCADE;
DROP INDEX IF EXISTS weekly_improvement_plans_week_uq;
CREATE UNIQUE INDEX IF NOT EXISTS weekly_improvement_plans_user_week_uq ON weekly_improvement_plans (user_id, week_start);

ALTER TABLE performance_symbol_snapshots ADD COLUMN IF NOT EXISTS user_id integer REFERENCES users(id) ON DELETE CASCADE;
DROP INDEX IF EXISTS perf_sym_snap_uq;
CREATE UNIQUE INDEX IF NOT EXISTS perf_sym_snap_user_uq ON performance_symbol_snapshots (user_id, symbol, range_key);

ALTER TABLE ai_performance_snapshots ADD COLUMN IF NOT EXISTS user_id integer REFERENCES users(id) ON DELETE CASCADE;
DROP INDEX IF EXISTS ai_perf_snap_range_uq;
CREATE UNIQUE INDEX IF NOT EXISTS ai_perf_snap_user_range_uq ON ai_performance_snapshots (user_id, range_key);

-- DB-level guard: new or updated rows must carry an owner. NOT VALID keeps the
-- legacy NULL rows readable for the claim script while refusing new ones.
DO $$ BEGIN
  ALTER TABLE weekly_improvement_plans ADD CONSTRAINT weekly_improvement_plans_owner_required CHECK (user_id IS NOT NULL) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE performance_symbol_snapshots ADD CONSTRAINT performance_symbol_snapshots_owner_required CHECK (user_id IS NOT NULL) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE ai_performance_snapshots ADD CONSTRAINT ai_performance_snapshots_owner_required CHECK (user_id IS NOT NULL) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

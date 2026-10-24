-- Learning memory scopes (Tier 1 finalization, item 8).
--
-- strategy_edges and mistake_patterns were one global pool: every trader's
-- outcomes moved the same rows, and every trader read them. Each row now
-- belongs to exactly one scope:
--   scope_type 'user'                                  private to scope_owner
--   scope_type 'strategy' | 'account' | 'broker' |
--              'instrument' | 'portfolio'              private to scope_owner, keyed by scope_key
--   scope_type 'platform'                              anonymized aggregate: scope_owner 0,
--                                                      no trade ids; readable by traders
--                                                      only once `contributors` >= 3
--
-- Existing rows cannot be attributed (the writer never stored an owner), so
-- they become platform rows with contributors NULL ("legacy, unknown"):
-- operators still see them; traders do not, because their contributor count
-- is unknown. last_trade_id is cleared on platform rows (it identifies a
-- trader's trade). Nothing else is deleted.
--
-- Idempotent. Rollback (only before any scoped row is written):
--   DROP INDEX IF EXISTS strategy_edges_scope_cohort_uq; DROP INDEX IF EXISTS mistake_patterns_scope_cohort_uq;
--   CREATE UNIQUE INDEX strategy_edges_cohort_uq ON strategy_edges (symbol, signal_name, action);
--   CREATE UNIQUE INDEX mistake_patterns_cohort_uq ON mistake_patterns (tag, symbol, action);
--   ALTER TABLE strategy_edges DROP COLUMN scope_type, DROP COLUMN scope_key, DROP COLUMN scope_owner, DROP COLUMN contributors;
--   ALTER TABLE mistake_patterns DROP COLUMN scope_type, DROP COLUMN scope_key, DROP COLUMN scope_owner, DROP COLUMN contributors;

BEGIN;

ALTER TABLE strategy_edges ADD COLUMN IF NOT EXISTS scope_type text NOT NULL DEFAULT 'platform';
ALTER TABLE strategy_edges ADD COLUMN IF NOT EXISTS scope_key text NOT NULL DEFAULT '';
ALTER TABLE strategy_edges ADD COLUMN IF NOT EXISTS scope_owner integer NOT NULL DEFAULT 0;
ALTER TABLE strategy_edges ADD COLUMN IF NOT EXISTS contributors integer;

ALTER TABLE mistake_patterns ADD COLUMN IF NOT EXISTS scope_type text NOT NULL DEFAULT 'platform';
ALTER TABLE mistake_patterns ADD COLUMN IF NOT EXISTS scope_key text NOT NULL DEFAULT '';
ALTER TABLE mistake_patterns ADD COLUMN IF NOT EXISTS scope_owner integer NOT NULL DEFAULT 0;
ALTER TABLE mistake_patterns ADD COLUMN IF NOT EXISTS contributors integer;

-- Rows that already name an owner are that trader's private memory.
UPDATE strategy_edges SET scope_type = 'user', scope_owner = user_id WHERE user_id IS NOT NULL AND scope_owner = 0;
UPDATE mistake_patterns SET scope_type = 'user', scope_owner = user_id WHERE user_id IS NOT NULL AND scope_owner = 0;
-- Platform rows never carry a trade id.
UPDATE strategy_edges SET last_trade_id = NULL WHERE scope_type = 'platform';
UPDATE mistake_patterns SET last_trade_id = NULL WHERE scope_type = 'platform';

DROP INDEX IF EXISTS strategy_edges_cohort_uq;
DROP INDEX IF EXISTS mistake_patterns_cohort_uq;
CREATE UNIQUE INDEX IF NOT EXISTS strategy_edges_scope_cohort_uq
  ON strategy_edges (scope_type, scope_owner, scope_key, symbol, signal_name, action);
CREATE UNIQUE INDEX IF NOT EXISTS mistake_patterns_scope_cohort_uq
  ON mistake_patterns (scope_type, scope_owner, scope_key, tag, symbol, action);
CREATE INDEX IF NOT EXISTS strategy_edges_owner_idx ON strategy_edges (scope_owner, scope_type);
CREATE INDEX IF NOT EXISTS mistake_patterns_owner_idx ON mistake_patterns (scope_owner, scope_type);

COMMIT;

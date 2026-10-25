-- Tier 1 step 8 — per-user risk limits (exposure, leverage, concentration,
-- drawdown, instrument limits) and the equity high-water mark.
--
-- Additive and idempotent. `pnpm --filter @workspace/db run push` applies the
-- same change from the Drizzle schema; this file is for environments where
-- push is blocked by unrelated drift. Every new limit column is nullable, so
-- existing rows keep today's behaviour (platform ceilings) until a trader or
-- an admin sets a stricter value.

ALTER TABLE user_risk_settings ADD COLUMN IF NOT EXISTS max_leverage real;
ALTER TABLE user_risk_settings ADD COLUMN IF NOT EXISTS max_symbol_leverage real;
ALTER TABLE user_risk_settings ADD COLUMN IF NOT EXISTS max_positions_per_symbol integer;
ALTER TABLE user_risk_settings ADD COLUMN IF NOT EXISTS max_portfolio_risk_percent real;
ALTER TABLE user_risk_settings ADD COLUMN IF NOT EXISTS max_drawdown_percent real;
ALTER TABLE user_risk_settings ADD COLUMN IF NOT EXISTS symbol_limits jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE user_risk_limits ADD COLUMN IF NOT EXISTS max_leverage double precision;
ALTER TABLE user_risk_limits ADD COLUMN IF NOT EXISTS max_symbol_leverage double precision;
ALTER TABLE user_risk_limits ADD COLUMN IF NOT EXISTS max_positions_per_symbol integer;
ALTER TABLE user_risk_limits ADD COLUMN IF NOT EXISTS max_portfolio_risk_percent double precision;
ALTER TABLE user_risk_limits ADD COLUMN IF NOT EXISTS max_drawdown_percent double precision;

CREATE TABLE IF NOT EXISTS user_equity_peaks (
  id serial PRIMARY KEY,
  user_id integer NOT NULL,
  venue text NOT NULL,
  account_key text NOT NULL,
  peak_equity real NOT NULL,
  peak_at timestamptz NOT NULL DEFAULT now(),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS user_equity_peaks_account_uq ON user_equity_peaks (user_id, venue, account_key);

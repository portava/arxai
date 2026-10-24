-- Tier 1 step 1 — trading available by default (owner decision 2026-10-24).
--
-- Changes only the column defaults, so a fresh install seeds the
-- global_trading_settings singleton in LIVE mode with demo and live enabled
-- and the emergency stop released. An existing row keeps its current state:
-- a stop an operator engaged stays engaged until an owner/operator releases
-- it. Availability is not approval: every order still passes the guard chain
-- and the pre-trade Risk Governor. Idempotent.

ALTER TABLE global_trading_settings ALTER COLUMN platform_mode SET DEFAULT 'LIVE';
ALTER TABLE global_trading_settings ALTER COLUMN demo_enabled SET DEFAULT true;
ALTER TABLE global_trading_settings ALTER COLUMN live_enabled SET DEFAULT true;
ALTER TABLE global_trading_settings ALTER COLUMN emergency_kill_switch SET DEFAULT false;

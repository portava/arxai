-- Fail-closed defaults for a fresh install (owner decision 2026-11-04).
-- Column DEFAULTs only: no existing row is read or changed. The application
-- seed also writes these values explicitly, so this migration is for parity
-- between the schema and the database, not a prerequisite for the release.
ALTER TABLE global_trading_settings ALTER COLUMN platform_mode SET DEFAULT 'OFF';
ALTER TABLE global_trading_settings ALTER COLUMN demo_enabled SET DEFAULT false;
ALTER TABLE global_trading_settings ALTER COLUMN live_enabled SET DEFAULT false;

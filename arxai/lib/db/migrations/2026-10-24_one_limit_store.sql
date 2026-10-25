-- Tier 1 Risk Governor — one trader-editable limit store.
--
-- risk_settings (the older settings page) and user_risk_settings (the Risk
-- Governor page) both held a trader's limits; the governor enforced the
-- strictest of the two. This folds each trader's risk_settings limits into
-- user_risk_settings so the effective limits do not change, then the code
-- reads and writes only user_risk_settings.
--
--   enforced before (strictest of both): risk per trade %, daily loss %,
--     open trades, trades per day, max lot → LEAST(current, legacy)
--   shown on the older page but not enforced: weekly loss %, losing streak,
--     loss cooldown → applied only where the trader changed them from the
--     page default (5 / 3 / 30), tighten-only; weekly also fills an unset cap
--     (the older page showed it to the trader as in force).
--
-- Only rows with a user_id are folded. Ownerless legacy rows are left as
-- they are (never guess who owns them). Idempotent: LEAST/GREATEST against
-- the already-folded value is a no-op, and legacy_merged_at marks the run.

ALTER TABLE user_risk_settings ADD COLUMN IF NOT EXISTS legacy_merged_at timestamp;

WITH legacy AS (
  SELECT DISTINCT ON (user_id)
    user_id,
    CASE WHEN risk_per_trade_pct > 0 THEN risk_per_trade_pct END AS per_trade,
    CASE WHEN max_daily_loss_pct > 0 THEN max_daily_loss_pct END AS daily,
    CASE WHEN max_weekly_loss_pct > 0 THEN max_weekly_loss_pct END AS weekly,
    CASE WHEN max_open_trades > 0 THEN max_open_trades END AS open_trades,
    CASE WHEN max_trades_per_day > 0 THEN max_trades_per_day END AS per_day,
    CASE WHEN max_lot_size > 0 THEN max_lot_size END AS lot,
    CASE WHEN stop_after_losing_streak > 0 THEN stop_after_losing_streak END AS streak,
    CASE WHEN cooldown_after_loss_minutes > 0 THEN cooldown_after_loss_minutes END AS cooldown
  FROM risk_settings
  WHERE user_id IS NOT NULL
  ORDER BY user_id, id DESC
)
INSERT INTO user_risk_settings AS u (
  user_id, max_risk_per_trade_percent, max_daily_loss_percent, max_weekly_loss_percent,
  max_open_trades, max_trades_per_day, max_position_size, max_consecutive_losses,
  cooldown_after_loss_minutes, legacy_merged_at
)
SELECT
  l.user_id,
  LEAST(1, l.per_trade),
  LEAST(3, l.daily),
  l.weekly,
  LEAST(3, l.open_trades),
  LEAST(5, l.per_day),
  l.lot,
  COALESCE(l.streak, 3),
  COALESCE(l.cooldown, 30),
  now()
FROM legacy l
ON CONFLICT (user_id) DO UPDATE SET
  max_risk_per_trade_percent = LEAST(u.max_risk_per_trade_percent, EXCLUDED.max_risk_per_trade_percent),
  max_daily_loss_percent     = LEAST(u.max_daily_loss_percent, EXCLUDED.max_daily_loss_percent),
  max_open_trades            = LEAST(u.max_open_trades, EXCLUDED.max_open_trades),
  max_trades_per_day         = LEAST(u.max_trades_per_day, EXCLUDED.max_trades_per_day),
  max_position_size          = LEAST(u.max_position_size, EXCLUDED.max_position_size),
  max_weekly_loss_percent    = CASE
    WHEN EXCLUDED.max_weekly_loss_percent IS NULL THEN u.max_weekly_loss_percent
    WHEN u.max_weekly_loss_percent IS NULL THEN EXCLUDED.max_weekly_loss_percent
    WHEN EXCLUDED.max_weekly_loss_percent <> 5 THEN LEAST(u.max_weekly_loss_percent, EXCLUDED.max_weekly_loss_percent)
    ELSE u.max_weekly_loss_percent END,
  max_consecutive_losses     = CASE WHEN EXCLUDED.max_consecutive_losses <> 3
    THEN LEAST(u.max_consecutive_losses, EXCLUDED.max_consecutive_losses) ELSE u.max_consecutive_losses END,
  cooldown_after_loss_minutes = CASE WHEN EXCLUDED.cooldown_after_loss_minutes <> 30
    THEN GREATEST(u.cooldown_after_loss_minutes, EXCLUDED.cooldown_after_loss_minutes) ELSE u.cooldown_after_loss_minutes END,
  legacy_merged_at           = COALESCE(u.legacy_merged_at, now()),
  updated_at                 = now();

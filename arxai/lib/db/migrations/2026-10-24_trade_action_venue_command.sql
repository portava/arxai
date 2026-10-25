-- Tier 1 Trade Engine consolidation — a confirmed Trade Action now becomes a
-- command in its venue's governed queue (DEMO: mt5_demo_commands, LIVE:
-- arx_live_commands) instead of a BLOCKED row in the legacy mt5_commands
-- mailbox. These columns record which. Additive and idempotent.

ALTER TABLE trade_action_requests ADD COLUMN IF NOT EXISTS execution_venue text;
ALTER TABLE trade_action_requests ADD COLUMN IF NOT EXISTS venue_command_id text;

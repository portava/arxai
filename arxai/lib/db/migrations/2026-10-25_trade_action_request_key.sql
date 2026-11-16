-- Additive retry identity. Apply before deploying the Tier 1 completion changes.
-- NULL keys preserve existing drafts. No historical row is claimed or rewritten.
ALTER TABLE trade_action_requests ADD COLUMN IF NOT EXISTS client_request_key text;
ALTER TABLE trade_action_requests ADD COLUMN IF NOT EXISTS client_request_hash text;
CREATE UNIQUE INDEX IF NOT EXISTS trade_action_requests_user_request_key_uq
  ON trade_action_requests(user_id, client_request_key);
-- Rollback: roll back application code; leave additive columns/index in place.

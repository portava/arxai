-- Owner decision 13 (2026-10-25) — confirmed SIMULATED opens (Trade Action
-- Center, My Trades) book PAPER orders through the Trade Engine pipeline with
-- retry-safe idempotency: one paper order per (user, request key). A retried
-- confirm finds the order it already booked instead of booking a second one.
-- Additive and idempotent: one nullable column, one unique index. NULL keys
-- (every existing and every other order) are distinct and unconstrained.
-- Not applied to production by this change (owner runbook).

ALTER TABLE paper_orders ADD COLUMN IF NOT EXISTS client_request_key text;
CREATE UNIQUE INDEX IF NOT EXISTS paper_orders_user_request_key_uq
  ON paper_orders (user_id, client_request_key);

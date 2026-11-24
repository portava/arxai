CREATE INDEX IF NOT EXISTS bridge_v2_events_deal_history_receipt_idx
  ON bridge_v2_events (user_id, server_received_at_epoch_ms)
  WHERE message_type = 'DEAL_HISTORY' AND accepted AND bridge_connection_id IS NOT NULL;

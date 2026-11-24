CREATE INDEX IF NOT EXISTS bridge_v2_events_tick_replay_idx
  ON bridge_v2_events (user_id, bridge_connection_id, stream_key, server_received_at_epoch_ms)
  WHERE message_type = 'TICK' AND accepted;

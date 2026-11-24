CREATE INDEX IF NOT EXISTS ati_deriv_quote_frames_symbol_epoch_idx
  ON ati_deriv_quote_frames (symbol, epoch);

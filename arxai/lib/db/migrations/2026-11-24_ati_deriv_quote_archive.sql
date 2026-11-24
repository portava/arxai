CREATE TABLE IF NOT EXISTS ati_deriv_quote_frames (
  stream_id uuid NOT NULL,
  symbol text NOT NULL CHECK (symbol ~ '^(R_(10|25|50|75|100)|1HZ(10|25|50|75|100)V)$'),
  epoch bigint NOT NULL CHECK (epoch > 0),
  received_at_ms bigint NOT NULL CHECK (received_at_ms > 0),
  released_at_ms bigint NOT NULL CHECK (released_at_ms >= received_at_ms AND released_at_ms >= epoch * 1000),
  bid double precision,
  ask double precision,
  PRIMARY KEY (stream_id, symbol, epoch),
  CHECK ((bid IS NULL AND ask IS NULL) OR
    (bid IS NOT NULL AND ask IS NOT NULL AND bid > 0 AND ask >= bid AND ask < 'Infinity'::double precision))
);

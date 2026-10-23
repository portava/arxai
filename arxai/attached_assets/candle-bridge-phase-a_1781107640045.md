# MT5 EA Candle Bridge v1 — PHASE A (Diagnosis + Data Layer + Ingest)

Scanner candles are failing because the app depends on external provider candles that cannot reliably backfill or scroll ("Provider free tier has no older-than cursor", 1m shows 1–2 bars). The fix is to make MT5 terminal/broker history the source of truth for chart candles when an EA bridge is connected.

This is PHASE A of two. Phase A builds the data layer and ingest path. Do NOT touch the Scanner frontend, candle source priority, or subscriptions in this phase — that is Phase B. Do not break live trading, heartbeat, or command execution.

## CRITICAL: existing work check

An MT5 candle ingestion foundation with EA-facing endpoints already exists in this codebase from earlier work. Before writing any code:
- Find it. Name its endpoint(s), handler file(s), and any schema/table it uses in your diagnosis report.
- EXTEND it. Do not create a parallel ingest endpoint or a duplicate candles table. If the existing structure conflicts with this spec, adapt the spec's naming to the existing structure and say so explicitly in your report.

## Step 1 — Diagnose the current candle path end-to-end

Trace every source currently feeding Scanner candles:
- frontend Scanner chart component
- candle fetch hook
- /api/data/candles or equivalent endpoint
- provider adapter
- ARX market-data fallback
- the existing MT5 bridge/candle ingestion code (see above)
- cache/database layer
- Ruby/scanner read path

Produce a short report in your response naming:
- exact frontend component fetching candles
- exact endpoint called
- exact backend handler
- exact provider/adapter used
- why 1m returns only 1–2 candles
- why 5m/15m behave differently
- whether MT5/EA candles are currently used at all, and what the existing ingestion foundation does today
- whether any fallback is pretending to be broker history

Do not guess. Add temporary debug logs only if needed; remove them or gate behind development logging.

## Step 2 — Canonical candle data model

Create or update (extend existing if present) a table for broker candles:

broker_candles:
- id
- bridge_id (or broker_account_id, match existing convention)
- symbol
- broker_symbol
- timeframe  ← enum, see canonicalization rule below
- open_time_utc
- close_time_utc
- open, high, low, close
- tick_volume
- real_volume
- spread
- source = "mt5_ea"
- source_terminal_id
- is_closed_bar
- received_at
- broker_server_time
- quality_status
- quality_reason

Unique key: bridge_id + broker_symbol + timeframe + open_time_utc

Indexes:
- (bridge_id, broker_symbol, timeframe, open_time_utc DESC)
- (symbol, timeframe, open_time_utc DESC)
- (received_at DESC)

Upsert candles. Never duplicate.

### Timeframe canonicalization rule
Pin the timeframe enum at the schema level: M1, M5, M15, H1, H4, D1. The EA, the ingest endpoint, and all read paths must use these exact strings. Add a single shared normalizer (e.g. `normalizeTimeframe()`) that maps any legacy formats ("1m", "60", "1h") to the canonical enum at API boundaries. Reject unknown timeframes at ingest.

### Closed-bar finalization rule
- A bar arrives with isClosed=false → upsert freely (forming bar updates in place).
- A bar arrives with isClosed=true for a row currently is_closed_bar=false → overwrite once and mark closed. This is the finalization write.
- A bar arrives for a row already is_closed_bar=true → ignore unless OHLC + volume match exactly (idempotent re-send). If they differ, do not overwrite; increment a rejected counter and record quality_reason="closed_bar_conflict".

## Step 3 — EA candle ingest endpoint

Extend the existing EA-facing endpoint family with (or confirm/upgrade if it already exists):

POST /api/mt5/candles/ingest

Request body:
{
  bridgeId, accountLogin, serverName, terminalId, eaVersion, brokerTime,
  batches: [
    { symbol, brokerSymbol, timeframe,
      bars: [ { time, open, high, low, close, tickVolume, realVolume, spread, isClosed } ] }
  ]
}

Security (reuse existing bridge auth/shared secret/HMAC pattern):
- Reject unknown bridge/account.
- Reject stale timestamps.
- Reject malformed bars.
- Reject impossible OHLC: high < max(open, close); low > min(open, close); high < low; non-positive prices.
- Do not expose raw master bridge data to normal users.
- Store per bridge/account/symbol/timeframe only.

Response:
{
  ok: true,
  acceptedBars,
  rejectedBars,
  latestStoredBySymbolTimeframe,
  nextBackfillHints
}

Bars inside a batch are oldest-to-newest. Apply the closed-bar finalization rule above on every upsert.

## Step 4 — Backfill state machine

Create broker_candle_backfill_status:
- bridge_id
- broker_symbol
- timeframe
- target_from_utc
- oldest_stored_utc
- newest_stored_utc
- last_request_at
- last_ingest_at
- status: NOT_STARTED | BUILDING | PARTIAL | COMPLETE | BROKER_LIMITED | ERROR
- reason
- bars_stored
- retry_count

Update this table on every ingest. The backend must be able to answer, per bridge/symbol/timeframe: are broker candles live, partial, still building, broker-limited, or absent.

Retention targets (used for status computation, the EA enforces actual backfill):
M1: 30 days · M5: 90 days · M15: 180 days · H1: 2 years · H4: 5 years if available · D1: max available.

## Step 5 — Phase A tests

Prove:
- Duplicate candle ingest upserts instead of duplicating.
- Bad OHLC is rejected.
- Unknown timeframe string is rejected; legacy formats are normalized at the boundary.
- Current forming candle (isClosed=false) updates the existing row.
- Closed-bar finalization rule: forming→closed overwrites once; closed→conflicting-closed is rejected with quality_reason; closed→identical-closed is idempotent.
- backfill_status rows update on ingest (newest/oldest/bars_stored/status).
- Normal user cannot access another user's bridge candle data.
- Trading heartbeat and command execution paths are untouched (no regressions in their tests).

Validate ingest end-to-end with a synthetic batch (clearly synthetic, inserted via the real endpoint in a test, then cleaned up or isolated to test DB). Do NOT seed fake candles into the live read path.

## Phase A acceptance criteria

Do not pass unless:
- Diagnosis report delivered (including what the existing ingestion foundation does and how you extended it).
- broker_candles + broker_candle_backfill_status exist with the unique key, indexes, enum, and finalization rule.
- /api/mt5/candles/ingest accepts a valid synthetic batch and reports acceptedBars/rejectedBars correctly.
- All Phase A tests pass. Typecheck passes.
- Live trading, heartbeat, and execution are unaffected.
- Response includes: what was previously feeding Scanner candles, why it failed, what the ingest path now does, candles ingested per timeframe in the test run, and any blocker.

Critical:
- Do not fake a pass with sample candles in the live path.
- Do not mark external-provider candles as broker candles.
- Do not break live trading or command execution.
- Do not start Phase B work (Scanner source priority, frontend, subscriptions, diagnostics page).

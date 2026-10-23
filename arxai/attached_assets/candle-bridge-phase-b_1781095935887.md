# MT5 EA Candle Bridge v1 — PHASE B (Source Priority + Frontend + Subscriptions + Diagnostics)

Prerequisite: Phase A is complete and verified — broker_candles, broker_candle_backfill_status, the extended /api/mt5/candles/ingest endpoint, and the closed-bar finalization + timeframe canonicalization rules all exist and their tests pass. If any Phase A piece is missing, stop and report instead of rebuilding it.

Phase B wires stored broker candles into Scanner, Ruby, and market-read systems, fixes the frontend, and adds diagnostics. Do not break live trading, heartbeat, or command execution.

## Step 1 — Scanner candle source priority

The Scanner candle endpoint must select sources in this order:

Priority 1: MT5 EA broker candles from broker_candles, if bridge connected and candleBridgeEnabled=true.
Priority 2: Paid/pro external market provider, only if explicitly better/fresher, tagged as such.
Priority 3: External free provider fallback, clearly tagged as limited.
Priority 4: No candles / honest empty state.

Never present free-provider partial candles as broker/live candles.

The API response must include:
{
symbol, timeframe, candles,
source, sourceLabel, sourcePriority,
isBrokerCandleFeed, isLive, isDelayed, isPartialHistory, hasCurrentBar,
oldestAvailable, newestAvailable,
retentionStatus, backfillStatus, qualityStatus, qualityReason,
nextCursor, canLoadOlder, loadOlderMode
}

For EA-backed candles, “load older” must use a database cursor on open_time_utc (loadOlderMode=“db_cursor”), never the provider older-than cursor. Timeframes use the canonical enum (M1/M5/M15/H1/H4/D1) with the shared normalizer at the API boundary.

Do not delete the provider candle path. It remains as fallback only.

## Step 2 — Frontend Scanner chart

Scanner chart must:

- Load latest candles from the backend endpoint above.
- Support scroll-back via the backend db cursor when loadOlderMode=“db_cursor”.
- Display source truth from sourceLabel/backfillStatus:
  - “Broker candles via MT5 EA”
  - “Broker history building”
  - “External provider limited”
  - “Delayed market data”
  - “No broker chart feed”
- If only 1–2 candles exist, show a clear loading/backfill state instead of pretending the chart is complete.
- If 1m is still building: “Broker history is still building from MT5. Current bars are available, older candles are syncing.”
- If broker history is limited: “Broker history limit reached for this timeframe.”
- Fix mobile badge overflow: the yellow status badges currently overflow the viewport. Wrap them into a scrollable chip row or stack them. No horizontal page overflow.

## Step 3 — Active-symbol subscription

When a user opens Scanner for a symbol/timeframe:

- Backend records interest in that symbol/timeframe.
- The EA heartbeat response carries desired candle subscriptions, if the current bridge command channel supports it. If it does not, document the gap; do not invent a new channel.
- Priority order for the EA: active chart symbols first, broad scanner symbols second, background backfill third.

This prevents backfilling every market before the user can see a chart.

## Step 4 — Ruby / market-read integration

Ruby and the market-read/scanner systems must read candle qualityStatus/backfillStatus and reduce stated confidence when history is partial. A read over isPartialHistory=true data must not present itself as fully verified.

## Step 5 — Admin Candle Bridge Diagnostics

Add an admin/owner-only diagnostics page or section:

- bridge connected yes/no
- candleBridgeEnabled yes/no
- symbols subscribed
- per timeframe: latest bar time, oldest bar time, bars stored, last ingest, backfill status, source, last error
- buttons: “Request backfill now”, “Refresh active symbol candles”, “Copy diagnostics”

Admin visibility must not leak raw account details, consistent with existing master-bridge visibility rules.

## Step 6 — Phase B tests

Prove:

- MT5 EA candle source outranks external provider when broker candles exist.
- Free provider “no older-than cursor” does not block scrollback when broker candles exist (db cursor used instead).
- 1m with only 2 bars returns isPartialHistory=true and backfillStatus=BUILDING or PARTIAL, never “verified”/complete.
- Source tagging: provider candles are never labeled as broker candles.
- Ruby/scanner reads reflect reduced confidence on partial history.
- Normal user cannot access another user’s bridge candle data through the Scanner endpoint.
- Admin diagnostics does not leak raw account details.
- Scanner mobile badge row does not overflow the viewport.
- Live trading, heartbeat, and execution paths unaffected.

## Phase B acceptance criteria

Do not pass unless:

- EURUSD M1, M5, M15, H1, H4, D1 return candles from broker_candles when the EA bridge is connected (or, if no live EA data is available in this environment, the priority logic is proven via tests with synthetic broker_candles rows clearly confined to tests).
- User can scroll older candles via the ARX database cursor.
- API clearly reports source and backfill quality in every response.
- Mobile Scanner no longer has overflowing source badges.
- Ruby read confidence changes based on candle completeness.
- Tests pass. Typecheck passes.
- Response includes: what now feeds Scanner candles, the exact priority decision logic location, and the remaining blocker that EA-side code cannot be deployed from Replit (the EA candle pump is delivered separately).

Critical:

- Do not fake a pass with sample candles in the live path.
- Do not mark external-provider candles as broker candles.
- Do not hide missing history behind “verified.”
- Do not break live trading or command execution.
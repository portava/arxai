---
name: MT5 broker feed activation via v2 ingest
description: How the v2 bridge ingest feeds mt5Provider so mt5_broker wins in the router
---

The v2 ingest service (`POST /api/bridge/v2/ingest`) is the activation point for
the broker chart feed. **After** the trace-row transaction commits, and **only**
when `result.accepted === true`, an accepted *fresh* (freshnessVerdict !== STALE)
`TICK`/`CANDLE` is pushed into the in-memory `mt5Provider`:
- `CANDLE` → `mergeCandleFromMT5(symbol, candle, timeframe)` — merges ONE closed
  bar (upsert-by-bar-time, ascending, capped ~1500). Do NOT use
  `updateCandlesFromMT5` here — it REPLACES the whole series, which is wrong for
  single-bar v2 events and would destroy history.
- `TICK` → `updateQuoteFromMT5` (bid/ask/spread).
The feed is best-effort (try/catch) so it can never throw into the EA response.
`marketDataRouter` then serves the top `mt5_broker` slot when that symbol's series
is fresh.

**Why STALE/duplicate/out-of-sequence are never fed:** an old or replayed bar must
never masquerade as a live feed. STALE returns early; non-accepted outcomes skip
the feed entirely.

**How to apply / honesty:** v1.50 does NOT stream TICK/CANDLE — only the separate
**v2 Beta Kernel** EA does (read-only producer, run ALONGSIDE v1.50). Validate the
server path with crafted real-shaped v2 ingest payloads
(`scripts/src/bridgeV2IngestFeedTest.ts`). This path is market-data telemetry
only — it touches no execution path, 16-gate, arx_live_* table, balance, or fill,
and the CI guard `check-bridge-v2-truth` must stay green (only a market-data
import was added to ingest).

**Confirmed live (2026-06-09):** the v2 kernel streamed real accepted/LIVE CANDLE
rows (USDCHF M5) into the feed — the pipeline works end-to-end. Diagnosing feed
liveness via the DB (`bridge_v2_events` grouped by `message_type`):
- **Heartbeat continuing ≠ candles flowing.** HEARTBEAT/ACCOUNT/POSITIONS are
  TIMER-driven (every ~10s regardless of market); CANDLE/TICK are TICK-driven
  (`OnTick` pushes the just-closed bar only when a new tick arrives). A quiet
  symbol pushes candles sparsely (saw ~1/hr on a labelled-M5 stream, then idle)
  while heartbeats keep coming. Judge candle liveness by CANDLE recency, not
  connection liveness.
- **Per-attached-chart only.** The kernel streams just `_Symbol` + the chart's
  `PERIOD_CURRENT` (e.g. one USDCHF M5 chart ⇒ only USDCHF M5). It cannot cover
  the universe from one chart; broader coverage needs more charts or a kernel
  redesign to iterate Market Watch.
- Real EA pushes carry a non-zero `transport_latency_ms` + proper
  `stream_key "SYM|TF"` + a `bridge_connection_id`; test injections show
  `lat=0`, `conn=NULL`, `stream_key "default"` — don't count those as live proof.

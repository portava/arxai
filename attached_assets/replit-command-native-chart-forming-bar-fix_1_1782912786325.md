# COMMAND — FIX THE SLOW ARX NATIVE CHART (consume the forming-bar SSE it already ignores)

Read this entire command before changing anything. This is a **FRONTEND-ONLY** fix to ONE file. The ARX Native Chart is slow ("barely moves, loads sticks slowly") because it repaints candles from an **8-second poll** and IGNORES the real-time forming-bar frames that are already streaming to it. Do NOT touch the EA (`.mq5` — the broker-facing component is fine, already streaming ticks). Do NOT touch the backend (`formingBarComposer`, `chartTickStream`, `/api/bridge/v2/ingest` — already synthesizing and pushing the forming bar). Do NOT touch any trade gate, feed verdict, or closed-bar logic. The fix is: make the chart APPLY the `forming_bar` SSE frames it's currently discarding.

## THE ROOT CAUSE (verified in source)
The full real-time pipeline already exists (Task #496): EA v155 streams ticks (default-on: `StreamLiveBrokerData`, `EnableLiveTickStream`, ~1s throttle) → backend `formingBarComposer.ts` synthesizes the forming (current-interval) bar → `chartTickStream.ts` pushes it via SSE at `GET /api/chart/tick-stream` as `type:"forming_bar"` events. BUT the consumer drops it:
- `ARXNativeChart.tsx` renders candles from `data?.candles` (the `/api/chart/candles` query) on `refetchInterval: 8000, staleTime: 4000` (lines ~309-310, 316-317) — an 8-second repaint. That is the visible lag.
- The chart DOES open the SSE `EventSource` (1 occurrence) but only reads the **`feed_status`** event off it (comment ~line 346-348) — it **ignores the `forming_bar` frames on the same connection.**
So the live-movement data arrives and is thrown away; the chart moves only every 8s via poll.

## THE FIX (one file: `artifacts/trading-dashboard/src/components/charts/ARXNativeChart.tsx`)

Make the chart consume the `forming_bar` SSE events it already receives and apply them to the live (current-interval) candle:
1. On the EXISTING `EventSource` connection to `/api/chart/tick-stream` (the one already opened for `feed_status`), also handle the `type:"forming_bar"` frames. Each frame carries the forming bar's OHLC + open/close time (per `chartTickStream.ts` payload: `openTimeMs`, `closeTimeMs`, OHLC, and `tickWallMs` for latency).
2. When a `forming_bar` frame arrives, UPDATE the last candle in the candlestick series (the current-interval bar) with the forming OHLC — i.e. `series.update({ time, open, high, low, close })` for the forming bar's open-time. This moves the live candle tick-by-tick between polls, matching MT5.
3. Keep the existing `/api/chart/candles` poll as the CLOSED-BAR backstop (it can even slow down or stay at 8s — it's now just the authoritative closed-bar series + gap-fill). The SSE `forming_bar` drives the LIVE movement; the poll supplies confirmed closed bars.
4. When the forming bar's interval closes (a new interval opens, or the next poll brings the now-closed bar), the polled closed bar becomes authoritative for that slot — the forming tip is replaced by the confirmed closed bar. Ensure no double-paint / flicker at the boundary: the forming bar and the closed bar share the same open-time key, so `series.update` on that key naturally reconciles.

### Correctness / edge cases
- **Symbol/timeframe match:** only apply a `forming_bar` frame if its symbol+timeframe matches the chart's current selection (the SSE is per symbol+tf; guard against a stale frame after the user switches symbol).
- **Interval alignment:** the forming bar's open-time must align to the chart's timeframe bucket; use the frame's `openTimeMs` as the series time key (don't synthesize your own).
- **No forming tip yet:** if no `forming_bar` has arrived (market closed, or no ticks yet), the chart shows the polled closed bars as today — the fix is purely additive, never worse than current.
- **Reconnect:** if the `EventSource` drops, the existing reconnect (for `feed_status`) covers `forming_bar` too since it's the same stream — confirm the handler re-attaches.

## NON-NEGOTIABLE — SAFETY & SCOPE
- **FRONTEND ONLY.** Do NOT modify any `.mq5` EA file. The EA is already streaming ticks correctly; the broker-facing component must not be touched.
- **Do NOT modify the backend** (`formingBarComposer.ts`, `chartTickStream.ts`, `chart.ts`, `/api/bridge/v2/ingest`, `brokerCandleStore.ts`) — they already produce and push the forming bar correctly.
- **Display-only.** The forming bar is rendered into the chart's visible candle for VISUAL real-time movement ONLY. It must NEVER feed the trade-confirmation gate, the scanner verdict, the feed-freshness gate, or any execution path. Those already read CLOSED bars only (`brokerCandleStore` refuses forming-over-closed; scanner uses "closed bars" floor) — do NOT change that, and do NOT route the forming tip into any of them.
- **Closed-bar series stays authoritative for data/decisions.** The forming tip is a visual overlay on the current bar; the confirmed closed-bar series (from the poll / candle contract) remains the source of truth for everything except the live visual.
- Diff limited to `ARXNativeChart.tsx` (+ possibly a small SSE-frame type if one is shared). Nothing in EA / backend / gate / scanner.

## TESTS / VERIFY
- Dashboard typecheck green.
- If there's a chart component test, add/confirm: a `forming_bar` SSE frame updates the last candle (series.update called with the forming OHLC at the forming open-time); a frame for a non-matching symbol/tf is ignored; when a new closed bar arrives from the poll it reconciles the same time-key without duplicate bars.
- `ci:guards` green (nothing in the trade/gate/scanner path changed — confirm the import-boundary + chart-truth guards still pass, proving the forming tip didn't leak into a gated module).
- Manual (operator, on the running app): open the ARX Native Chart on a live symbol and confirm the current candle now moves smoothly (tick-cadence, ~1s) instead of jumping every 8s — matching the MT5 chart. Confirm synthetics and a forex symbol both move (forex depends on the MT5-bridge tick stream).

## FINAL REPORT
- Confirmation the fix is in `ARXNativeChart.tsx` only; the exact change (consume `forming_bar`, `series.update` the live bar) with line refs.
- Confirmation NO `.mq5` / backend / gate / scanner file was touched.
- Confirmation the forming tip is display-only and does not enter any trade/feed/scanner gate (closed-bar series still authoritative).
- Typecheck + guards results; and the manual observation that the chart now moves in real time.

## COMPLETION STANDARD
- The ARX Native Chart's current candle updates in real time from the `forming_bar` SSE frames (tick-cadence), instead of only repainting every 8s — matching MT5 movement.
- Change is FRONTEND-ONLY (one file); EA and backend untouched; the forming tip is display-only and never reaches the trade-confirmation / feed / scanner gates (those still read closed bars, unchanged).
- Dashboard typecheck green; `ci:guards` green (no gated module altered); manual confirmation the chart now tracks MT5.

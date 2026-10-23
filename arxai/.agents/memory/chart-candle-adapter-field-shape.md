---
name: Chart candle adapter must read openTime/closeTime
description: Why the Scanner chart can go globally empty even when the backend returns clean candles
---

# Scanner chart candle adapter field-shape contract

`GET /api/chart/candles` returns `NormalizedChartCandle` objects whose bar-time
fields are **`openTime` / `closeTime`** (ISO 8601 strings). There is **no**
`time` or `timestamp` field on that shape.

The frontend adapter in `ScannerChartPanel.tsx` must resolve the bar time as
`openTime ?? closeTime ?? time ?? timestamp` and parse to epoch **milliseconds**.
The chart consumer then does `Math.floor(c.time / 1000)` to get
lightweight-charts `UTCTimestamp` (seconds).

**Why:** An adapter that reads only `c.time`/`c.timestamp` resolves every bar to
`new Date("").getTime()` = `NaN`, the `Number.isFinite(c.time)` filter drops all
bars, and the chart shows "No live candles" for **every** symbol — even when the
backend returned 50 clean real candles. This presents as a global outage but is
a pure frontend field-name mismatch.

**How to apply:** If the chart is empty for all symbols, first probe the backend
in-process (`getChartCandles`/`routeCandles`) — if it returns candles, the bug is
the adapter field shape, not the feed. Synthetic symbols (e.g. V75) being empty
is separate and honest (Deriv `ws_not_connected` / `MT5_BROKER_FEED_NOT_ACTIVE`).
Keep internal time in ms; convert to seconds only at `setData`.

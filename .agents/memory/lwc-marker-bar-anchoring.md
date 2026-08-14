---
name: lightweight-charts marker bar anchoring
description: Series markers must always anchor to a bar actually in the series; dangling anchors crash during paint, uncatchably.
---

**Rule:** In lightweight-charts v5, every series marker time must exactly match a bar currently loaded in the series. A marker anchored to a missing bar makes `findBar()` return null and `SeriesBarColorer.Candlestick` throws "Value is null" during PAINT — long after the `setData`/marker call returned, so it is uncatchable at any call site.

**Why:** The Market Scanner page crashed whenever the chart sat open across candle refreshes: the poll's fixed-size window slid forward via `setData`, the oldest bars rolled off, and structure markers snapped once at draw time kept pointing at dropped bars.

**How to apply:**
- Any React effect that snaps markers to candle bars MUST include the candles array in its deps — snapping once and never re-anchoring is the bug. (News-marker effect had `candles`; structure effect didn't.)
- The chart-engine adapter self-heals: it stores RAW structure lines/markers and re-snaps them against the sanitized in-series bar times inside `setCandles`, in the same tick as `setData` (skip redraw when no anchor moved). Never trust a caller-passed "latest bar time" — snap it too (the raw last candle can be sanitize-dropped).
- Canonical snap helper: `snapSecToCandle` in `lib/chart-engine/candleSanitize.ts` (greatest bar ≤ target, forward to first bar, null when no bars). Never fabricate a bar to anchor to; drop the marker instead.
- Regression lock: `lightweightChartsAdapter.markers.test.ts` (mocked lightweight-charts, asserts re-snap on window slide, skip-when-unmoved, no-bars→no markers, destroy drops raw state).

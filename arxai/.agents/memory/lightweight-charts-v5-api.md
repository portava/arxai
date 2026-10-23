---
name: lightweight-charts v5 API
description: v5 removed the v4 series/marker methods; casts hide the breakage from typecheck so it only throws at runtime.
---

The dashboard pins `lightweight-charts@^5.2.0`. v5 changed the chart API in ways
that are **silent at compile time but throw at runtime**:

- `chart.addCandlestickSeries(opts)` (v4) was **removed**. Use
  `chart.addSeries(CandlestickSeries, opts)` with `CandlestickSeries` imported
  from `"lightweight-charts"`. (Same pattern for `LineSeries`, etc.)
- `series.setMarkers([...])` (v4) was **removed**. Use the standalone plugin
  `createSeriesMarkers(series, [...])`, also imported from `"lightweight-charts"`.
- `series.createPriceLine(...)` still exists in v5.
- Series `time` fields are branded `Time`; cast plain unix-seconds with
  `as UTCTimestamp` (import the type), not `as unknown as number`.

**Why:** the JSDoc comment blocks in `typings.d.ts` still *mention*
`addCandlestickSeries`, but the shipped JS only has `addSeries`. Code that did
`(chart as unknown as { addCandlestickSeries })...` passed typecheck and then
threw `TypeError: ...is not a function` inside the chart `useEffect` — but only
once **real candles loaded** (the call sits behind a `candles.length > 0`
guard), so it looked fine with an empty feed and crashed the whole page for a
user with a live data feed (propagated to the page-level RouteErrorBoundary →
"This page hit a snag").

**How to apply:** never use `as unknown as <shape>` casts to call a charting
method — it defeats the only check that would catch a major-version API removal.
When a charting call "should work" but the page crashes, grep the installed dist
(`node_modules/.pnpm/lightweight-charts@*/.../dist/*.mjs`) to confirm the method
actually ships before trusting the typings (JSDoc examples mention removed v4
methods).

## Don't rebuild the chart to update overlays — update price lines incrementally

A chart `useEffect` that includes poll-driven state in its deps (e.g.
`symbolPositions`, `symbolPending` from a 10s positions poll) will call
`chart.remove()` + `createChart()` on **every poll tick**, discarding the user's
zoom/scroll and burning CPU/GC. Split it:
- chart-creation effect depends ONLY on what actually changes the candle set
  (`[candles, symbol]`); store the real series in a ref and bump a `chartEpoch`
  state when (re)created.
- overlay effect depends on the poll state + `chartEpoch`; it removes the
  previously-created price lines (track them in a `useRef<IPriceLine[]>`) via
  `series.removePriceLine(line)` and re-adds the current set with
  `createPriceLine` onto the EXISTING series.

`ISeriesApi<SeriesType>`, `IPriceLine`, and `SeriesType` are all exported types
from `lightweight-charts` v5 — type the refs with them, no casts.
**Why:** candles in this app are fetched on symbol/timeframe/reload only (not
polled), so keying chart creation on `[candles, symbol]` is stable while overlays
still refresh every poll. Applied in `ScannerChartPanel.tsx`.

## v5 createSeriesMarkers: build the array inline OR annotate it (never widen via .map)

`createSeriesMarkers(series, markers)` expects `SeriesMarker<Time>[]`, a
discriminated union (bar-anchored `position` member vs price-anchored `price`
member). An **inline** array literal narrows correctly via contextual typing. But
building it through `markerOverlays.map(o => ({ time, position: cond?"belowBar":"aboveBar", shape: ... }))`
widens `position`/`shape` to `string`, so TS can no longer pick the bar member and
fails with `Property 'price' is missing in type ... required in SeriesMarkerPrice`.
**Fix:** annotate the result array type — `const markerData: SeriesMarker<UTCTimestamp>[] = markerOverlays.map(...)`
— which restores contextual typing to the callback. This is a type annotation,
NOT a cast, so it still catches real API removals.
**How to apply:** `SeriesMarker` is exported from `lightweight-charts` v5;
`import { type SeriesMarker }`. Reuse the plugin via `.detach()` + recreate
(stored in a ref) rather than re-typing `Parameters<>` generics.

## v5 markers crash if their time isn't an EXACT loaded bar — snap to a real bar

A bar-anchored marker (`createSeriesMarkers` on a candlestick series) whose
`time` does not exactly equal one of the bars in `series.setData(...)` makes the
v5 colorer call `ensureNotNull(findBar(barIndex, precomputedBars))` → `findBar`
returns null → **throws `"Value is null"` on EVERY repaint** (multiple/sec under
live forming-tip ticks), propagating to the section/route ErrorBoundary. Candles
sit on fixed interval boundaries (M15=900s); economic-event/structure markers
carry the engine's *exact* event second, which almost never lands on a bar.
**Why:** lightweight-charts resolves marker position by bar membership, not by
nearest-time; an off-grid time has no bar and is fatal, not ignored.
**How to apply:** never feed a raw event/structure time to a marker. Snap it to
the greatest bar `time` ≤ target (binary search — `snapSecToCandle` in
`scannerChartFormat.ts`) against the **same sanitized array fed to `setData`**
(build it via `sanitizeCandlestickData`, not the raw candle prop, or off-by-one
filtering desyncs the two). Anchor entry/last markers to
`sanitized[sanitized.length-1].time`, never `rawCandles[last]`. Applies to ALL
marker paths: economic events + structure overlay (`ScannerChartPanel`) and the
position mini-chart entry marker (`PositionMiniChart`). Anchoring an event to its
containing bar's open is a truthful display compromise, not fabricated data.

## "Value is null" can ALSO come from a NaN OHLC bar — `typeof === "number"` is the trap

Separate from the off-grid-marker cause above: a candlestick bar with a NaN /
Infinity OHLC field is treated by v5 as a *whitespace* point whose colorer
(`SeriesBarColorer.Candlestick._private__styleGetter` → `ensureNotNull`) throws
`"Value is null"` on the NEXT repaint — uncatchable at the `setData`/`update`
call site. The boundary guard `candleSanitize.ts` (`isValidCandlestickPoint` /
`sanitizeCandlestickData`) uses `Number.isFinite` and is the correct shared gate;
`lightweightChartsAdapter.ts` runs it on both setData and update.
**The bug:** `ScannerChartPanel.tsx`'s real-time forming-tip SSE handler validated
the incoming bar with `typeof b.open !== "number"` — but `typeof NaN === "number"`
is **true**, so a NaN OHLC slipped straight into `series.update()` and crashed the
chart on the next forming-tip paint (correlated with a live tick, looked
intermittent/"pre-existing").
**How to apply:** EVERY candlestick feed (setData AND live update) must reject
non-finite OHLC with `Number.isFinite`, never a bare `typeof === "number"`. When you
need TS to also narrow a field (e.g. `openTimeMs` feeding `Math.floor`), combine
both: `typeof x !== "number" || !Number.isFinite(x)`. Regression test:
`candleSanitize.test.ts`.

## "Object is disposed" on unmount/HMR — guard the ResizeObserver + teardown

`chart.remove()` can run while a `ResizeObserver` callback is still queued; the
late callback then calls `chart.applyOptions({width})` on a disposed chart →
`"Object is disposed"` (DevicePixelContentBoxBinding → resizeCanvasElement),
which trips the ErrorBoundary during HMR/unmount. **Fix:** a `disposed` flag the
RO callback short-circuits on, `try/catch` around the `applyOptions` call, and
`try/catch` around `chart.remove()` itself in the effect cleanup.

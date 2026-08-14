---
name: Structural trendline overlay shared drawing path
description: How detected-trendline/channel overlays are drawn identically on the ARX native chart and the Scanner panel, and the gate that differs between them.
---

# Structural trendline overlay — one drawing path, two charts

The detected-trendline / channel-rail overlay (backend Chart Intelligence
`trendlineOverlay` verdict) is drawn by ONE shared imperative routine,
`lib/chart-engine/structureLines.ts` (`applyStructureLines` / `clearStructureLines`).
Both consumers call it:

- ARX native chart → via the engine adapter (`LightweightChartsAdapter.setStructureLines`).
- Scanner page panel (`ScannerChartPanel`, raw lightweight-charts) → directly.

**Why:** the Scanner panel uses raw lightweight-charts, not the adapter, so
duplicating the draw/clear/teardown logic there would silently drift from the
native chart. Sharing the routine guarantees identical geometry (ascending
points, dashed `:rail`, width 1→1 else 2), identical clear-before-draw teardown,
and identical fail-safe try/catch containment.

**How to apply:** never inline structure-drawing in a chart component — call the
shared routine and hold its returned `StructureLinesHandles` in a ref so the next
draw / a symbol switch can clear exactly what was drawn.

## The honesty gate differs by chart — match the chart's own feed verdict

The overlay is DOUBLE-gated: `overlay.visible` (backend fold) AND the chart's own
live-feed verdict. But the second gate is NOT the same variable on both charts:

- ARX native chart gates on `conf.aiUsable && isLivePriceAffordance`.
- ScannerChartPanel gates on `isLiveDisplay` (`isLivePriceDisplay(displayStatus)`,
  where `displayStatus` comes from `useScannerTruth`). This is the panel's
  existing feed-confidence verdict that already drives its badge + price-line
  visibility — reuse it, do not introduce a second/parallel feed check.

Both effects also depend on `chartEpoch` so a chart rebuild (symbol/timeframe
switch) re-runs the draw onto the fresh series and clears instrument A's
structure before B's.

Display-only on both: the overlay adds NO trade affordance and touches NO
execution path.

## Tests

- `lib/chart-engine/structureLines.test.ts` — unit-locks the shared routine
  (clear-before-draw, ascending points, style mapping, degenerate-line skip,
  marker filtering, null-safety). Mock `lightweight-charts` via `vi.hoisted`
  (a plain top-level const TDZs inside the hoisted `vi.mock` factory).
- `components/charts/ARXNativeChart.trendline-overlay.test.tsx` — render-proof of
  the gate semantics the Scanner effect mirrors 1:1. A full ScannerChartPanel
  render-proof was deliberately skipped: the 2300-line panel needs dozens of
  mocked hooks and would be flaky; the gate is identical to the locked native one.

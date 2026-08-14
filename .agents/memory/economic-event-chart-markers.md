---
name: Economic-event chart markers honesty
description: How the scanner chart's economic-event markers stay honest (feed-gated + window-filtered) and where the pure logic lives.
---

# Economic-event chart markers (scanner / ARX Native chart)

The scanner chart draws economic-calendar events as vertical markers on the
price time axis. They reuse the SAME honest, real-or-absent calendar the
market-truth snapshot already serves — there is no separate data source:
`useSymbolTruth` → snapshot `news` → `buildNews(radar)` → `buildMarketImpactRadar`
→ `getEconomicCalendar`. So a marker feature is a DISPLAY change, not a data
change; do not add a new calendar fetch.

## The two honesty rules (both pure-tested)

- **Feed-gate:** markers may render ONLY when the chart's own feed is CONFIRMED —
  `displayStatus === "LIVE" || "FALLBACK_COMPOSITE"` (LIVE or DELAYED). On
  STALE / ANALYSIS_ONLY / UNAVAILABLE the chart draws NO markers. A marker sits
  on the candle time axis, so an unconfirmed time axis must not carry one.
- **Window-FILTER, never edge-clamp:** show only events inside
  `[firstSec, lastSec + barSec * NEWS_MARKER_LOOKAHEAD_BARS]`. Pre-history /
  far-future events are OMITTED (return null), not pinned onto the chart edges.
  A near-future in-window event anchors to the right edge (`lastSec`) since no
  candle exists past it yet; in-history events sit at their true time.

**Why:** the old logic `Math.min(Math.max(evSec, firstSec), lastSec)` clamped
every out-of-range event onto an edge, producing stray markers at false times,
and rendered regardless of feed state — both violate chart-honesty.

## Where it lives

- Pure helpers (unit-tested) in
  `artifacts/trading-dashboard/src/components/scanner/scannerChartFormat.ts`:
  `isFeedConfirmedForEventMarkers`, `inferBarSeconds`, `resolveEventMarkerSec`,
  `NEWS_MARKER_LOOKAHEAD_BARS`. Keep new pure marker logic HERE (the panel
  imports lightweight-charts + the whole tree and can't be unit-tested directly).
- The markers `useEffect` in `ScannerChartPanel.tsx` composes those helpers; its
  deps MUST include `displayStatus` or the feed-gate won't re-evaluate on feed
  changes.
- Toggle chip is the single `news` layer (`SMART_LAYER_TOGGLES`, id `news`,
  label "Economic events"); the same `layerToggles.news` also gates the textual
  "Impact radar" strip and the toast alerts. Only the chart MARKERS are
  feed-gated — the strip/alerts are textual (no time-axis claim) and stay as-is.

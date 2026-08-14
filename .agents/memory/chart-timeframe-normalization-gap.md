---
name: Chart timeframe normalization gap (Ruby read-chart)
description: Why a confirmed-LIVE chart can still make Ruby's read-chart return INSUFFICIENT — lowercase tf ("15m") not normalized on the chart-intelligence path.
---

# Chart timeframe normalization gap

**Symptom:** Ruby's chart read returns "Chart intelligence unavailable — cannot
verify chart data" / "feed unavailable" / basis INSUFFICIENT for a symbol whose
chart is visibly streaming LIVE candles. Looks like a symbol-mapping or feed
outage; it is neither.

**Root cause:** timeframe-STRING casing, not symbol/router/history.
- The frontend stores the shared chart timeframe **lowercase** — `useScannerTimeframe`
  `DEFAULT_TF = "15m"` (localStorage `scanner.chart.timeframe`).
- The candle-render path normalizes both cases (`chartCandlesQuery` has
  `case "M15": case "m15":`) and the router `marketDataRouter.routeCandles`
  normalizes `"15m"→"M15"` — so the **chart shows live data**.
- But `useAiChartOverlays.requestRubyRead` POSTs `{ symbol: normalized, timeframe }`
  with the timeframe **forwarded raw** (only the symbol is uppercased). The
  backend `POST /api/me/assistant/read-chart` (`readChartSchema`) accepts any
  string and casts `timeframe as ChartTimeframe` WITHOUT normalizing, then
  `buildRubyChartContext → buildChartIntelligenceState` uses it against
  `CHART_TIMEFRAMES`/`TIMEFRAME_SECONDS` which are **UPPERCASE-only** (`timeframes.ts`,
  no lowercase normalizer). A lowercase `"15m"` → intelligence/truth build fails
  (timeframeSeconds undefined → NaN staleness math) → buildRubyChartContext throws
  → rubyCtx=null → basis INSUFFICIENT.
- `derivProvider.toDerivGranularity` is also uppercase-only (`"15m"→null →
  TIMEFRAME_UNSUPPORTED`), reinforcing the asymmetry.

**Proof pattern (live probe, ephemeral session):** same symbol "VOLATILITY 75 (1S)
INDEX", confirmed deriv LIVE_FEED:
- `read-chart timeframe:"M15"` → VERIFIED, chartTruthScore 100, dataQuality ok.
- `read-chart timeframe:"15m"` → INSUFFICIENT, gated, "cannot verify chart data".
- Direct `/market-data/deriv/candles` M15 and `/chart/candles` tf=M15 both return
  live clean candles for the exact `(1S)` uppercase string → 1HZ75V (symbol map +
  router path both fine; not insufficient history).

**Callers:** `ScannerChartPanel` uppercases tf before `<RubyChartRead>` (works) and
even rewrites storage to uppercase on mount; `ScalpSignalCard` hardcodes `"M1"`
(works). The failing path is the **live-chart overlay** `requestRubyRead`, which
forwards the raw lowercase scanner tf. Intermittent: after visiting Scanner,
storage flips to "M15" and reads start working — masks the bug.

**Why:** the app has TWO timeframe normalizers (frontend `normalizeChartTimeframe`/
`chartCandlesQuery`, backend `marketDataRouter`) but the chart-intelligence /
Ruby-read path bypasses both. Any new caller of read-chart or buildChartIntelligenceState
must normalize tf to canonical uppercase ChartTimeframe first.

**How to apply / safe fix (gate-neutral):** normalize the timeframe to canonical
ChartTimeframe at the read-chart handler entry (or in buildRubyChartContext),
mirroring `normalizeChartTimeframe`, and/or uppercase `timeframe` in
`requestRubyRead` like the symbol already is. Pure robustness — weakens no gate;
INSUFFICIENT stays the honest verdict for genuinely-bad feeds.

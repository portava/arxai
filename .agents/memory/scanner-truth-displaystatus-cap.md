---
name: Scanner displayStatus capped by resolved truth
description: Why the chart's live affordance must come from resolved scanner truth, not raw feed status, and why TIMEFRAME_THRESHOLDS must cover every chart-selectable timeframe.
---

# Scanner displayStatus must be capped by resolved truth

`resolveScannerTruth()` returns `displayStatus`/`isLivePrice` derived from the
**resolved** `candleStatus` + `analysisLevel`, NOT from the raw feed display
status. `LIVE` only when candles are live AND analysis is `full`; otherwise it
downgrades (`STALE` / `FALLBACK_COMPOSITE` / `ANALYSIS_ONLY` / `UNAVAILABLE`).
The chart (`ScannerChartPanel`) renders `truth.displayStatus`.

**Why:** every scanner surface (header strip, read-gate, advisory cards, chart)
must agree. If the chart reads a feed-only "LIVE" while the shared truth says the
data is insufficient / stale / mismatched, the chart looks more confident than
the rest of the UI — the exact divergence class this contract exists to prevent.
Min-candle count, candle age, and quote↔candle consistency are honesty gates; the
chart's live badge has to inherit them.

**How to apply:** never let a scanner surface compute its own liveness from
`feedStatus` directly. Read `truth.displayStatus` / `truth.isLivePrice`. If you
add a new feed/quality state, extend the `resolvedDisplayStatus` mapping in
`scannerTruth.ts` and add a `displayStatus`-cap assertion in
`scannerTruth.test.ts`.

Advisory cards (Ruby Market Read, Timing Intelligence, the ScannerReadGate
banner) must derive their "is this actionable?" decision from the shared
`useScannerReadGate(symbol)` hook (`downgraded = truth != null && analysis.level
!== "full"`), NOT a private feed-status fetch. When `downgraded`, a card must
withhold numeric confidence/scores, replace its confident call-to-action with an
honest "not actionable" line, and suppress actionable levels — never present a
confident read over delayed/stale/insufficient/blocked data. Cross-surface
agreement (strip verdict ⇔ chart displayStatus/isLivePrice ⇔ read-gate
level/downgraded) is locked by the consistency block in `scannerTruth.test.ts`.

# TIMEFRAME_THRESHOLDS must cover every chart-selectable timeframe

`thresholdsFor(tf)` falls back to the **strict 1m** bucket for any timeframe not
in `TIMEFRAME_THRESHOLDS`. The chart can select 30m (→ M30), so a missing `30m`
entry silently downgrades valid 30m data against a 1m freshness/min-candle
budget.

**How to apply:** any timeframe the chart UI can pick (`1m,5m,15m,30m,1h,4h,1d`)
must have its own threshold row. There is a guard test asserting every
chart-selectable timeframe is present — keep it in sync when adding timeframes.

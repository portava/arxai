---
name: Scanner timeframe token mismatch (backend M15 vs canonical 15m)
description: Why feeding a scanner signal's timeframe straight into useScannerTruth falsely flags live data "stale".
---

Scanner signals carry **backend-format** timeframes (`M1`/`M5`/`M15`/`M30`/`H1`/`H4`/`D1` — `DEFAULT_TIMEFRAMES`; scalp signals hardcode `M1`). But the feed-truth pipeline keys on **canonical lowercase** ids (`1m`/`5m`/`15m`/…):

- `toApiTimeframe(tf)` lowercases then switches on `1m`/`5m`/… — an `M15` input misses every case and defaults to `M5` ⇒ the wrong candles are fetched.
- `thresholdsFor(tf)` / `TIMEFRAME_THRESHOLDS` are lowercase-keyed — `m15` isn't a key, so it falls back to the **strict 1m budget** (90s candle-age cap). An M5/M15 bar is minutes old ⇒ `candleStatus = "stale"` ⇒ `actionable = false` ⇒ spurious amber warning + a demo ack + a `feedWarning` on a genuinely-live feed.

**Symptom:** the header (which uses the lowercase `useScannerTimeframe` default `15m`) says "Live" while `ScannerTradeModal` warns "stale" — exactly the cross-surface header-vs-modal disagreement / "make live look broken" dishonesty the honesty work forbids.

**Why:** two timeframe vocabularies coexist (backend enum for signals/candles API; canonical lowercase for chart UI + threshold tables) and they silently disagree on an unknown token (no throw, just a strict fallback).

**How to apply:** any UI that hands a *signal's* timeframe to `useScannerTruth` (or to `thresholdsFor`) must first normalize with `normalizeChartTimeframe()` (in `lib/chartCandlesQuery.ts`), which accepts EITHER form and returns the canonical lowercase id (unknown/null ⇒ `5m`, never the strict 1m bucket by accident). Pin it with a test asserting `thresholdsFor(normalizeChartTimeframe("M15")) === TIMEFRAME_THRESHOLDS["15m"]`.

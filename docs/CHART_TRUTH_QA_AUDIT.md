# ARX Chart Truth QA Audit — Phase 5

Generated as part of Phase 5 (Chart truth QA & fixture tests).  
This document is the per-timeframe audit table required by the mission's 38-point checklist.  
Verified against the Phase 1–4 implementation in `artifacts/api-server/src/lib/data/chart/`.

---

## Per-Timeframe QA Table

| Column | Meaning |
|---|---|
| **Count** | Typical candles returned at limit=300 from the active provider |
| **Source** | Active provider when configured; provider chain on fallback |
| **OHLC pass** | `high ≥ max(O,C)` and `low ≤ min(O,C)` for all returned bars |
| **Aggregation pass** | Bar bucket duration matches `timeframeMs(tf)` |
| **Forming-candle pass** | Last bar `isComplete=false` when its `closeTime > now` |
| **Merge pass** | No seam gap/overlap between last complete bar and forming bar |
| **Outlier pass** | OUTLIER_SPIKE / OUTLIER_WICK / HISTORICAL_PERIOD_SHIFT flags applied advisory-only (never dropped) |
| **Mirror pass** | Symbol + timeframe from response match the requested values |
| **Price-align pass** | Price decimal count consistent with `symbolProfile.pricePrecision` |
| **Scale pass** | Y-axis `autoScale=true` in `ARXNativeChart`; `rightPriceScale.autoScale` enabled (Phase 2) |
| **Ruby allowed** | `aiUsable = (quality === "clean")` — Ruby reads only when the feed is confirmed clean |

---

### EURUSD (Forex — representative major)

| Timeframe | Count | Source | OHLC | Aggregation | Forming | Merge | Outlier | Mirror | Price-align | Scale | Ruby |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **M1** | 0–300 | `assistant_real:twelve_data` | ✓ | ✓ | ✓ | ✓ | advisory | ✓ | ✓ (4 dp) | ✓ | ⚠ Provider-limited† |
| **M5** | 0–300 | `assistant_real:twelve_data` | ✓ | ✓ | ✓ | ✓ | advisory | ✓ | ✓ (4 dp) | ✓ | ✓ when clean |
| **M15** | 0–300 | `assistant_real:twelve_data` | ✓ | ✓ | ✓ | ✓ | advisory | ✓ | ✓ (4 dp) | ✓ | ✓ when clean |
| **H1** | 0–300 | `assistant_real:twelve_data` | ✓ | ✓ | ✓ | ✓ | advisory | ✓ | ✓ (4 dp) | ✓ | ✓ when clean |
| **H4** | 0–300 | `assistant_real:twelve_data` | ✓ | ✓ | ✓ | ✓ | advisory + OUTLIER_WICK gate | ✓ | ✓ (4 dp) | ✓ | ✓ when clean |
| **D1** | 0–300 | `assistant_real:twelve_data` | ✓ | ✓ | ✓ | ✓ | HISTORICAL_PERIOD_SHIFT on old-epoch bars‡ | ✓ | ✓ (4 dp) | ✓ | ✓ when clean |

**†** M1: TwelveData free tier allocates ≈800 requests/day total. Under high usage M1 data may be absent or exhausted. Safe-mode behaviour: router returns honest empty + `safetyNote`; quality="unavailable"; no fallback to simulator data. Ruby blocked (`aiUsable=false`).

**‡** XAUUSD/D1 specifically: 2023 bars (~\$1900–\$2100) appear in a 300-bar D1 view alongside 2025 bars (~\$3200+). These are **real historical data**, not bad ticks. HISTORICAL_PERIOD_SHIFT flag is applied to the old-epoch bars. Assessment stays CLEAN (advisory). Y-axis `autoScale=true` (Phase 2) includes all visible bars automatically.

---

### V75 Index (Deriv Synthetic — representative)

| Timeframe | Count | Source | OHLC | Aggregation | Forming | Merge | Outlier | Mirror | Price-align | Scale | Ruby |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **M1** | 0–300 | `deriv` | ✓ | ✓ | ✓ | ✓ | advisory | ✓ | ✓ (3 dp) | ✓ | ✓ when clean |
| **M5** | 0–300 | `deriv` | ✓ | ✓ | ✓ | ✓ | advisory | ✓ | ✓ (3 dp) | ✓ | ✓ when clean |
| **M15** | 0–300 | `deriv` | ✓ | ✓ | ✓ | ✓ | advisory | ✓ | ✓ (3 dp) | ✓ | ✓ when clean |
| **H1** | 0–300 | `deriv` | ✓ | ✓ | ✓ | ✓ | advisory | ✓ | ✓ (3 dp) | ✓ | ✓ when clean |
| **H4** | 0–300 | `deriv` | ✓ | ✓ | ✓ | ✓ | advisory + OUTLIER_WICK gate | ✓ | ✓ (3 dp) | ✓ | ✓ when clean |
| **D1** | 0–300 | `deriv` | ✓ | ✓ | ✓ | ✓ | advisory | ✓ | ✓ (3 dp) | ✓ | ✓ when clean |

Volume is always 0 for Deriv synthetics (algorithm-generated; no traded volume). This is **expected** and does not trigger ZERO_VOLUME_GHOST (synthetic source is explicitly excluded from that check).

---

## Provider Limitation Map

| Provider | Affected Timeframes | Limitation | Safe-mode behaviour |
|---|---|---|---|
| TwelveData (free) | M1, sometimes M5 | ≈800 req/day budget; minute data missing for exotic pairs | Honest empty + `safetyNote`; quality="unavailable" |
| Polygon (free) | M1–H1 (forex) | Only D1 + `/prev` usable for forex on free tier (0–1 intraday bars) | quality="partial" or "empty"; `feedReadinessState` exposes reason |
| AlphaVantage (free) | M1, M5 | 5 req/min limit; no true intraday OHLC for forex | Honest empty on budget exhaustion |
| Deriv (WebSocket) | All TFs | Requires `DERIV_APP_ID`; no feed without it | `MT5_BROKER_FEED_NOT_ACTIVE` → falls through; quality="unavailable" |
| mt5_broker | All TFs | EA v1.27 pushes heartbeat/account/positions only — no ticks/candles yet | `MT5_BROKER_FEED_NOT_ACTIVE`; fast-fail; router falls through |

**Invariant**: No provider limitation ever causes the system to substitute simulator/mock data. The provider chain either returns real data or an honest empty state.

---

## 38-Point Checklist (Phase 5 Final QA Pass)

### Data source & mapping
- [x] **1. Real OHLC source identified** — `symbolProfile.ts` documents per-family source chain (forex → TwelveData/Polygon/AlphaVantage/Finnhub; synthetics → Deriv; MT5 → reserved). Source documented in every `TimeframeTruthResult.sourceDocumentation`.
- [x] **2. No mock candles in live mode** — `sourceModeFromProvider` classifies all known mock/shim identifiers as `"mock"`; truth engine sets `mockDataDetected=true`; chartDataService degrades quality to `"invalid"`; `aiUsable=false`. CI guard `check-chart-truth-mock-leak` enforces this statically on every commit.
- [x] **3. Correct OHLC mapping** — `normalizeCandles` maps `time` as bar-open for `deriv`/`mt5_broker`, bar-close for `assistant_real:*` (close-based provider convention). Bar interval = `timeframeMs(tf)`. Fixture test [F01]–[F06] verify.
- [x] **4. Correct aggregation** — `closeTime = openTime + timeframeMs(tf)` for every bar. Fixture tests [F20]–[F25] verify per-timeframe.
- [x] **5. Forming candle updates in place** — last bar's `isComplete=false` when `closeTime > now`. Fixture test [F07] verifies; `mergeSeam.formingBarDetected` in truth result confirms.
- [x] **6. Symbol mirror correct** — every `NormalizedChartCandle.symbol` matches the requested ARX symbol. Fixture test [F09] verifies.
- [x] **7. Timeframe mirror correct** — every `NormalizedChartCandle.timeframe` matches the requested timeframe. Fixture test [F08] verifies.
- [x] **8. Merge pass (historical + live seam)** — `analyzeSeam()` detects gap/overlap at the seam; `mergeSeam` in `TimeframeTruthResult` reports cleanly. Fixture tests [F17]–[F18] verify.

### Integrity & anomalies
- [x] **9. Invalid OHLC rejected (flagged)** — `isValidOhlc` catches `high < low`, `O/C outside H/L`, negatives, non-finite values. Bars are flagged `OHLC_INVALID` and kept (never silently dropped). Fixture test [F10] verifies.
- [x] **10. Duplicate timestamp rejected** — dedup collapses to latest bar; `DUPLICATE_BUCKET` flag on winner; `anomalies.duplicateCount` incremented. Fixture test [F11] verifies.
- [x] **11. Precision correct** — `pricePrecision` from `symbolProfile` feeds `normalizeCandles`; integer-pip bars trigger `precisionViolationCount > 0`. Fixture test [F16] verifies.
- [x] **12. Enough history** — `historyMinimumMet` in `TimeframeTruthResult`: ≥150 bars required (≥50 for D1). When not met → PARTIAL assessment. Reported per timeframe.
- [x] **13. Outliers flagged** — OUTLIER_SPIKE, OUTLIER_WICK, ZERO_VOLUME_GHOST, HISTORICAL_PERIOD_SHIFT are advisory flags (bars never dropped). Fixture tests [F13], [F19], [F24], [F25] verify.
- [x] **14. 1D wick investigated** — XAUUSD 2023 bars at ~\$1900–\$2100 are confirmed real historical data (not bad ticks). HISTORICAL_PERIOD_SHIFT flag applied. Finding documented in `candleTruthEngine.ts` header and `symbolProfile.ts`.
- [x] **15. Price basis identified or marked unknown** — `priceBasis` in every candle: BID (MT5), MID (TwelveData forex), LAST (indices), SYNTHETIC (Deriv). UNKNOWN only when provider is unrecognised. Fixture tests [F31]–[F32] verify.

### Chart rendering
- [x] **16. Y-axis fixed (auto-scale on visible bars)** — `rightPriceScale.autoScale=true` in `ARXNativeChart` (Phase 2). Only visible bars drive the Y range, eliminating the compressed-history symptom.
- [x] **17. Candles readable** — `VISIBLE_CANDLES_DESKTOP=150`, `VISIBLE_CANDLES_MOBILE=80`; chart opens on recent price action, not full compressed history. Reset Scale button available.
- [x] **18. Price alignment checked** — `brokerPriceAlignment.ts` provides broker-vs-feed alignment metrics; displayed in admin diagnostics.
- [x] **19. Scale pass** — Phase 2 `rightOffset=8`, `lockVisibleTimeRangeOnResize=false`, smart `setVisibleRange` on first paint; Reset Scale button restores default view.
- [x] **20. Mirror status reported** — `getMirrorStatus()` in `ARXNativeChart` maps quality/stale/fetching to `MirrorStatus` (Mirrored/Syncing/Stale/Conflict/Refreshing). Mirror Lock toggle present.
- [x] **21. Mobile readable** — responsive `effectiveHeight` with `mobileHeight` prop; `VISIBLE_CANDLES_MOBILE=80` for narrow viewports. `mobileHeight` defaults to `Math.max(320, Math.min(height, 380))` on screens < 768px.
- [x] **22. Chart Safe Mode present** — when quality="invalid", `ARXNativeChart` shows a clean user message overlay and pauses AI confidence. Defined in Phase 2.

### Gating
- [x] **23. Ruby gated on aiUsable** — `aiUsable = (quality === "clean")`. When the feed is stale/invalid/mock, `aiUsable=false` is published via `onChartContextChange`. Scanner/Ruby/Self-Trade surfaces must not trigger chart-confirmation reads on `aiUsable=false` feeds. Fixture test [F14]–[F15] verify.
- [x] **24. Scanner gated** — Scanner uses `feedConfidence()` from `lib/feed-confidence.ts`; `aiUsable` flag in the response controls whether Ruby chart reads are offered.
- [x] **25. Self-Trade gated** — `executeInstantTrade` does not use chart data directly; it re-runs the 16-gate evaluator server-side on every submission, independent of chart quality.
- [x] **26. AACI handshake present** — `chartHandshake.ts` implements the advisory readiness check for the chart surface; `enforceSensitiveAction` is called for chart-truth-dependent operations. Never a 17th live gate.
- [x] **27. User-safe messages present** — quality-to-message mapping in `buildMessage()` in `chartDataService.ts`; mock data shows "Chart data is unavailable — feed is syncing" (no admin detail). Warning field carries more context for admin-facing surfaces.
- [x] **28. Admin diagnostics present** — `truthResult` and `chartTruthScore` returned in every `ChartCandlesResponse`; admin-facing chart intelligence endpoint exposes full `TimeframeTruthResult`.

### Preservation
- [x] **29. Plan Buy/Sell wiring intact** — `ARXNativeChart` is view-only; trade placement routes through `executeInstantTrade` (the Global Instant Trade Router), which is unchanged.
- [x] **30. MT5/shared bridge route intact** — Bridge auth, per-user token, and EA-facing endpoints are unchanged by this phase.
- [x] **31. Risk Governor intact** — Risk parameters and per-symbol lot limits are evaluated server-side at dispatch, not at the chart layer.
- [x] **32. AACI intact** — AACI advisory-shadow layer is unaffected; chart truth signals are read-only inputs.
- [x] **33. Security Handshake intact** — `enforceSensitiveAction` catalog is unchanged; chart surfaces remain advisory.
- [x] **34. Ruby floating button intact** — `RubyChartRead` component unchanged; routes through read-only `POST /api/me/assistant/read-chart`.
- [x] **35. Bottom nav intact** — Navigation components are unchanged.
- [x] **36. `pnpm run typecheck` passes** — Verified after all Phase 5 changes.
- [x] **37. `pnpm run ci` passes** — All CI guards + test suites pass including the new `test:chart-truth-fixtures` and `check-chart-truth-mock-leak` guard.
- [x] **38. No runtime errors** — Workflows healthy; no new errors in api-server or dashboard logs.

---

## Fixture Test Summary

All 34 fixture tests (`[F01]`–`[F34]`) are defined in:

```
artifacts/api-server/src/lib/data/chart/__qa__/candleFixtures.test.ts
```

Run with:
```bash
pnpm --filter @workspace/api-server run test:chart-truth-fixtures
```

These tests:
- Are deterministic (fixed epoch, no `Date.now()`, no network/DB)
- Never use live data (source always `"dev"` or `"mock"`)
- Cannot leak fixture candles into the live pipeline (pure, stateless functions)
- Run on every commit via the `pnpm run ci` chain

---

## CI Guard Summary

Static guard added to `scripts/src/ci/check-chart-truth-mock-leak.ts`:

| Check | What it verifies |
|---|---|
| MOCK_SOURCE_GATE | `sourceModeFromProvider` classifies all mock/shim labels as `"mock"` |
| TRUTH_ENGINE_MOCK_GATE | `candleTruthEngine.ts` maps mock sourceMode → `mockDataDetected=true` → DEGRADED |
| DATA_SERVICE_QUALITY_GATE | `chartDataService.ts` maps `mockDataDetected` → quality="invalid", aiUsable=false |
| NO_MOCK_IN_LIVE_ROUTES | No chart route file imports or hardwires a mock provider string |

Run with:
```bash
pnpm --filter @workspace/scripts run ci:guards
```

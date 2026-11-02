# Visible-window price comparison — 2 November 2026

Status: implemented and validated offline; broader chart goal and release readiness remain incomplete.

Application commit: `13394dd1dc3f52af655f37902527c0294434c9ff`.
Branch: `codex/chart-performance-comparison-20261102`.
Base: `ba9eb72d4d02c4296c6fa6f2098c92bc9afae228`.

The owner's separate performance chat owns the broad optimization audit. This change adds chart capability; it does not install its patch or any held performance branch.

## Capability and comparison

[TradingView's official comparison guide](https://www.tradingview.com/support/solutions/43000543053-compare-see-how-symbols-perform-side-by-side/) documents same-percentage overlays, separate price scales and separate panes, with percentage origins changing as the visible range changes.

ARX now offers **Compare price change** beneath the native chart tools, including on Market Scanner. It opens an optional separate pane for the primary instrument and one chosen instrument. It follows the native chart's visible time window and rebases both percentage lines at their first exact shared closed-bar timestamp. Original prices, primary chart preferences, drawings and trade-ticket context are unchanged. Comparison loading is lazy and the extra shared-cache candle query stays disabled until an instrument is chosen. Closing removes its observer and query subscription.

This is not a same-main-chart overlay or independent-price-scale overlay. Multiple comparison instruments in one pane, deep-history comparison paging, persistent comparison selections, currency conversion, dividends/total-return adjustment and competitor performance parity remain open. The percentage pane uses elapsed UTC time rather than compressing non-trading time. Physical touch, hardware frame rate and live-feed latency are unmeasured. No MT5-specific comparison capability is claimed by this change.

## Evidence and arithmetic

- Reuses `matchesChartCandleOwner`, `captureSmartChartBars`, interval definitions and original UTC evidence; no new source authority or confidence policy.
- Validates source identity, exact requested symbol/timeframe, original UTC evidence, closed/final status, ordered and non-overlapping fixed-duration bars, positive finite OHLC and nonfuture close times.
- Computes `(observed close - its own baseline close) / its own baseline close * 100` independently for each symbol. The two baselines have the same timestamp. At least two shared timestamps must be present.
- No nearest-bar joins, filling, smoothing or invented candles. Missing bars and time gaps disconnect strokes; dots retain isolated observations. Outliers remain present. Numeric overflow is withheld; finite extreme percentages are scaled safely for SVG coordinates.
- Latest read failures or wrong-owner/clock evidence withdraw the plot, even if cached candles remain. A correction to a candle at the same timestamp recalculates the result.
- Stale historical data is identified; the view makes no live-price, trading-return or execution claim. Legends identify both sources and their closed-data endpoints. The accessible values table exposes each observed percentage.
- Percentage points are separate presentation data. No canonical OHLC, source response, account amount, AI assessment or trading state is mutated.

## Validation

Receipts: `/Users/areyouok/arx-tier1-release/chart-performance-comparison-20261102/`.

| Check | Actual result |
|---|---|
| Full frontend after fixture correction | 4,810 passed; 12 skipped; 0 failed; 274 files passed, 2 skipped |
| New math/component regressions | 22 included in the full run |
| Dashboard typecheck | Passed |
| Dashboard production build | Passed; existing large-chunk warning retained |
| Guards | 85/87; identical 43 normalized violation lines to pitchfork baseline; source scan count increased by 3 |
| Independent review | Static source review clear; initial findings and exact file hashes retained; reviewer did not run tests |
| Actual Scanner browser fixture | 12 checks passed on clean source `13394dd1`, build `af18297ddbfb9f8f` |

The browser fixture imports the real dashboard and native Scanner. It uses an isolated production Vite configuration, not the deployable output. All HTTP is intercepted; external requests, sockets and writes are blocked. The final run made 58 intercepted requests and blocked three known background/analysis POST attempts. There were no unexpected network attempts or page errors. Forty console errors from intentionally unavailable/blocked offline endpoints remain recorded; this does not establish whole-app API health.

The browser checks independently recalculate every displayed percentage from synthetic source candles, verify native zoom rebasing, source/canonical/displayed OHLC equality, narrow 390-pixel layout, removal after UTC evidence becomes unverified, close behavior and absence of chart embeds/TradingView branding. Desktop, mobile-size and withheld-state screenshots were visually inspected. Synthetic data is explicitly labelled in every screenshot; contract-qualified fixtures are not claims about provider data.

The browser driver selector was corrected after the application build: the existing accessible name is **Zoom in chart**. Application files did not change. The report/checkpoint commit therefore must not be described as a newly built application commit.

## Failures retained

- Baseline test file failed to import the not-yet-existing feature; no tests were collected. This is not a behavioral red/green test count.
- Initial typechecks exposed the string adapter epoch and a partial fixture's type assertion; both corrected.
- First full frontend run: 4,809 passed, 1 failed, 12 skipped. The large-outlier fixture generated a zero low, so the validator correctly withheld it. The corrected fixture preserves positive OHLC and still exercises approximately `1.7e308%`; no product validation was relaxed.
- Independent review found overlapping closed intervals and overflowing y-axis padding arithmetic. Both were fixed with regressions.
- First browser run passed six assertions then timed out looking for the wrong zoom-button name. Its result, screenshot and original driver are retained. Fresh-session rerun passed.
- Initial browser session exited before setup. Session listing and PID check confirmed termination before restarting; it was not treated as live from a stale handle.

Owned browser and loopback server are closed; all test/build processes are terminal. No deployment, main merge, Replit source sync, existing database change, worker activation or broker/live/demo test occurred. No speed improvement, TradingView/MT5 parity, architecture percentage or release-green claim is supported here.

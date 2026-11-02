# Indicator visibility by chart interval — 2 November 2026

Application commit: `25a221a73ff65cca74b854b8d5f0dda7b547226e`.
Final browser-driver commit: `247f56f67e87d2ae748c30262b0f0f72e7f6334a`.
Branch: `codex/chart-study-interval-visibility-20261102`, based on `5bdb42adc644449662fe097aa381f4e5359fb5b0`.

Scoped offline acceptance passed. The overall charting and architecture goal remains incomplete. No main/PR76 merge, deployment, Replit sync, database changes, worker activation or broker tests occurred. The separate optimization chat's changes and held performance branches were not installed.

## Behavior

Each native Smart Chart study can appear on selected supported intervals. Controls offer individual choices across the existing19 fixed intervals, all, none, current, current-and-above and current-and-below. Preferences persist through reloads. Missing restriction means all intervals; an empty selection means none. Unknown, duplicate and unsupported saved intervals are rejected.

Visibility changes presentation only. Hidden studies retain their original calculations and remain available to linked studies. Empty panes disappear; a hidden oscillator owner remains when a visible dependent shares its pane. The owner's explicit scale or default range context remains authoritative. Hidden drawings, guides and price overlays do not contaminate visible autoscale. Data-window numbers remain available and are explicitly labeled hidden; legends and PNG metadata identify interval-hidden studies. Source-qualified VWAP wording is preserved.

Explicit assistant show/comparison requests reveal the named study on the current interval while retaining other interval restrictions. Explanations and parameter edits preserve existing visibility. Switching the viewport interval cancels obsolete gestures/hover before changing pane layout. This does not calculate a different timeframe's study or change execution/AI confidence policy.

## Verified comparison

TradingView documents quick interval-visibility choices and further adjustments through indicator settings. ARX now provides the corresponding selection category in its existing Studies controls; exact UI equivalence is not claimed. [TradingView interval visibility](https://www.tradingview.com/support/solutions/43000686263-how-to-quickly-adjust-visibility-of-a-drawing-or-indicator/).

MT5 documents selecting indicator timeframes in Visualization and separately controlling Data Window display. This change covers timeframe display selection; an independent Data Window visibility option remains a gap. [MT5 indicator settings](https://www.metatrader5.com/en/terminal/help/charts_analysis/indicators).

Sources checked2November2026. The legacy comparison renderer is outside this feature's supported scope; product-default native rendering is verified. W1/MN1, custom calendar boundaries and cross-timeframe calculation remain unsupported rather than fabricated.

## Validation

| Check | Result |
|---|---|
| New model tests against base | 4 failed |
| Initial model plus existing study tests | 61 passed |
| Expanded focused tests | 263 passed,1 failed: explanation unexpectedly revealed hidden study |
| Hidden-owner painter regression before fix | 57 passed,1 failed |
| First post-fix focused run | 105 passed,1 failed: test incorrectly expected padded axis labels instead of actual range labels |
| Final full dashboard suite | 4,878 passed,12 skipped,0 failed;279 files passed,2 skipped |
| Dashboard typecheck and production build | Passed; large-chunk warning retained |
| Guards | 85/87; same43 normalized failure lines as prior checkpoint |
| Independent review | Scale-context issue fixed and re-reviewed; final hashes recorded |
| Actual offline Scanner browser | 14 passed,0 failed, completed native paint required |

Final tests and build used the application/test contents committed as25a221a7, with unchanged original timeouts and maxWorkers2. Subsequent commits changed only the checked-in browser driver. Browser fixture `76402348bd3bc52d` was built from clean97f35210; dashboard source is byte-identical to25a221a7 and247f56f6. The final driver at247f56f6 was run against that fixture. These are distinct source/evidence identities, not a claim that the full suite ran on a later commit.

Browser acceptance covers hidden RSI feeding visible SMA, unchanged complete computed observations for the same bars, unchanged source/display OHLC during visibility changes, empty-pane removal, actual M30 source candle spacing after interval switching, reload persistence, narrow390px controls and native rendering without a TradingView embed/logo. Desktop and mobile screenshots were visually inspected.98requests,7expected blocked POSTs,0unexpected requests,0page errors;67offline console errors retained. Synthetic historical observations, all APIs intercepted, external requests blocked. No live feed, physical touch, first-navigation or competitor speed acceptance claim.

Two failed browser attempts are retained: a syntax/row-shape defect in the driver, then an incorrect accessible button name. Neither was counted as acceptance. The application was unchanged during those repairs. CLI exit0 alone was not accepted; the final result's passed flag, individual checks, network errors and screenshots were inspected.

## Evidence and next work

Packet: `/Users/areyouok/arx-tier1-release/chart-study-interval-visibility-20261102`.
Repeatable browser driver: `scripts/scanner-qa/study-interval-visibility-acceptance.js`, using the existing committed production Scanner fixture and packet's API-interception setup.
Frontend commands: `pnpm --filter @workspace/trading-dashboard exec vitest run --maxWorkers=2`, `pnpm --filter @workspace/trading-dashboard exec tsc --noEmit`, and `pnpm --filter @workspace/trading-dashboard build`. Local runs used the established offline environment wrapper and read-only dependencies. The wrapper is not network isolation; browser interception supplies that boundary.

Remaining gaps include independent Data Window visibility, MT5 scale-by-line, arbitrary pane placement/merging, overlay scales and offset guides, guide-label collisions, cross-symbol/timeframe inputs, user scripts, multiple/main-chart relative comparisons, qualified weekly/monthly/deep history, additional drawing/chart families, cloud workspaces/server alerts, physical touch/accessibility and fair competitor latency evidence. Existing first-navigation/4x-CPU failures remain open. No parity, superiority, new performance gain, release-green or completion percentage is claimed.

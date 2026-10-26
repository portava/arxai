# ARX Smart Chart compared with TradingView and MT5

Assessed October 26, 2026. ARX status below refers to the tested PR #76 branch,
not a deployed release. This is a capability comparison based on official
platform documentation and ARX tests. It is not a measured speed competition,
an endorsement, or a percentage of full platform parity.

| Area | Commercial benchmark | ARX in this upgrade | Remaining gap |
|---|---|---|---|
| Price display and navigation | MT5 chart management includes chart types, scale/navigation and inspection controls [1] | Candlesticks, OHLC bars, close line; pan/zoom, Latest, Fit, Reset, linear/log, fullscreen, UTC OHLC inspector | Richer chart types, session/timezone controls and broader shortcut/context-menu coverage |
| Studies | MT5 documents 38 built-in indicators, configurable parameters and separate indicator windows [2] | Five configurable studies: SMA, EMA, Bollinger Bands, Wilder RSI, MACD; separate RSI/MACD panes; incremental updates | More studies, applied-price choices, multiple instances of one study, custom studies and exact cross-platform convention checks |
| Drawing tools | TradingView offers trend, Fibonacci/Gann, pattern, geometry and annotation families [3]; MT5 documents 44 analytical objects [2] | Horizontal levels, trend lines, Fibonacci retracement; editable prices/colors, object list, delete/hide, undo/redo, mouse/touch placement | Drag anchors/whole objects, snapping options, rectangles/rays/channels/text and richer styling |
| Multiple charts | TradingView supports configurable synchronization of layouts [4]; MT5 profiles preserve chart groups [5] | One or two charts, shared symbol, independent intervals/preferences; responsive stacking; primary alone supplies trade-setup context | More charts, different-symbol comparison, synchronized crosshair/zoom/time range and configurable linkage |
| Persistence | TradingView supports drawing synchronization within/across layouts [4]; MT5 templates/profiles save chart configuration [5] | Browser autosave; instrument/timeframe drawings synchronize between matching open charts; one reusable style/scale/studies template | Account-backed cloud saves, named workspaces/templates, import/export, versioning and recovery |
| Image sharing | MT5 exposes Save As Picture [1] | PNG with instrument, timeframe, UTC capture, source/feed verdict and study parameters | More export formats and workspace sharing |
| Data and execution evidence | Chart behavior depends on each platform's feed and account configuration | Existing ARX feed labels, freshness handling, history loading and gated trade ticket remain in use | Production feed/backfill verification and separately authorized broker validation; no parity claim for price/timestamp/indicator values |
| Rendering performance | No TradingView or MT5 runtime benchmark was performed | 5,000-bar local fixture: p95 snapshot 0.4 ms / tick 0.1 ms; with all five studies 0.9 ms / 0.5 ms | Paint/frame-budget profiling under sustained load, larger history, worst-case drawings, slow-device/network and long-session verification |

## What this release does not establish

ARX has a substantially more capable chart workspace, but full TradingView/MT5
parity is not established. Replay, custom script execution, advanced chart types,
volume-profile/order-flow tools, comprehensive drawing manipulation and cloud
workspaces are not implemented by this PR. Scanner Chart still uses its own
renderer; the native Smart Chart feature/performance claims do not apply to it.

The 170 passing chart-related tests, 87 architecture guards and browser fixture
are evidence for this release's implemented behavior. They do not prove broker
readiness, profitable trading, production feed reliability or overall-app 100%
completion. See [the acceptance report](SMART_CHART_ACCEPTANCE.md) for formulas,
benchmark scope and remaining operational verification.

## Official references

1. [MetaTrader 5 — Chart Management](https://www.metatrader5.com/en/terminal/help/charts_advanced/charts_manage)
2. [MetaTrader 5 — Technical Analysis](https://www.metatrader5.com/en/trading-platform/technical-analysis)
3. [TradingView — Drawing tools available](https://www.tradingview.com/support/solutions/43000703396-drawing-tools-available-on-tradingview/)
4. [TradingView — Multi-chart layouts](https://www.tradingview.com/support/solutions/43000629990-leveraging-multi-chart-layouts-in-your-analysis/)
5. [MetaTrader 5 — Templates and Profiles](https://www.metatrader5.com/en/terminal/help/charts_advanced/templates_profiles)

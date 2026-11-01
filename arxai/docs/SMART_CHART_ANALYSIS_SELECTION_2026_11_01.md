# Smart Chart selected-pane alignment — 1 November 2026

Tested application: `9982b5451b62f14d208da2c941fe1cacd03bbae1`, branch `codex/chart-analysis-selection-integration-20261101`, on saved base `41934a4c`. This is bounded offline acceptance, not release-green, deployment, architecture completion or competitor parity.

## What changed

The existing comparison chart picker can now select approved Common Stock catalogue entries, including AAPL. Its exact saved symbols and favourites stay separate from the primary Focus picker, shared symbol bus and trade ticket. Stock catalogue membership grants no data-feed or trading permission. Invalid saved/freeform symbols are not silently substituted. A trusted prefixed primary symbol can still detach from Follow primary.

The existing AssistantDock selects an explicit chart instance and source context. The same study, Fibonacci and historical-research owners bind only to that selection. Stock series identity is retained even when marketEvidence is null; qualified volume does not manufacture market-read or research-price authority. A quantity-only correction does not change the selected source. Source changes, removal and remount require explicit selection again; another pane is never silently substituted. The initial ready primary can select once. Primary trading/search controls stay primary-owned.

General remote chat and voice are held on analysis-only comparisons. Existing briefing, text, uploaded voice, recording and realtime hooks now reject stale request generations and stop obsolete playback. Pending permission, old upload cleanup, old recording deadlines and return-to-primary races cannot act on newer sessions. These are extensions of the existing hooks and owners, not new systems.

Reviewed isolated commits: comparison `d6550be8` (44 focused tests, three semantic mutations caught) and assistant `66d15b31` (241 focused tests). Root and Truth reviews found and closed scope/async ownership issues. Their counts overlap combined validation below.

## Exact-source validation

All 15 bounded commands ran on application `9982b545`; raw receipts retain their full heads and exits.

| Check | Pass | Fail | Skip |
| --- | ---: | ---: | ---: |
| Full frontend, 202 passing files | 3,219 | 0 | 11 |
| Targeted backend: providers, Truth, research and candle evidence | 513 | 0 | 0 |
| Actual Scanner comparison/VWAP browser assertions | 64 | 0 | 0 |
| Primary-chart phone layout assertions | 29 | 0 | 0 |
| Clock withdrawal / frozen research assertions | 46 | 0 | 0 |

Four typecheck units, dashboard/API builds, 87 guards and seven bindings also pass. These are not the full root/backend release lanes. Browser counts are repeated assertions, not distinct features.

Frozen production-mode fixture: `e01495c8583cecd2`. It mounts the actual dashboard Scanner and its real components; its isolated build is not a deployable app bundle. The primary remains EURUSD/M15; AAPL/M15 is selected through Two charts and the real comparison picker. The synthetic AAPL response is unchanged output from the actual mocked provider/router/Truth/getChartCandles pipeline at `084a0369`, fixture SHA-256 `47431eb58f1a539aa84a66461dccd8b95e05cb001186565bfa27c976cb0735df`. No provider was contacted.

Every rendered VWAP value was compared with independent raw-provider HLC3 × quantity arithmetic, with all visible qualified points covered. Manual and AI calculation settings, anchor, appearance and actual points agree. Checks also cover genuine trade-unit histogram values, fixed anchor on pan, explicit reanchor, quantity-only corrections, missing quantity, replacement series, source-selection withdrawal, exact layout restore, unmounted-pane refusal and unchanged primary configuration. Stock historical research correctly remains held for missing matching usable source evidence.

Root visually inspected the actual desktop stock candles/VWAP/histogram and primary phone chart/chat screenshots. No physical-phone keyboard, comparison-phone or performance acceptance follows. The three browser runs had zero page exceptions. Unavailable ancillary requests were 91/44/58; blocked write attempts were 6/3/3. All API writes and external requests were intercepted; local chart commands sent no chat/model/order writes. This does not certify unrelated dashboard sections served unavailable fixture data.

Four failed harness attempts are retained: expecting all loaded points instead of the library's exposed/visible data, equating optional visibility serialization instead of actual appearance, an obsolete pan selector, and an asynchronous observer wait that did not wait for the real poll. Product checks were not relaxed. Missing renderer points are compared at exact timestamps as unavailable, never zero.

Raw directory: `/Users/areyouok/arx-tier1-release/chart-analysis-selection-20261101/`; authoritative `final-receipt.json`, `checks.json` and three `*-browser.json` files. Isolated agent failures/reviews remain in sibling `chart-analysis-stock-selection-20261101` and `chart-active-pane-assistant-20261101` directories.

## Remaining work and boundaries

- VWAP saved-anchor text still conservatively says UTC unverified even where current stock bar clock is qualified. Exact anchor-bound display alignment is a remaining Truth/UI gap; do not simply infer old-anchor authority from the current chart.
- Volume Profile is missing. The recorded next-gap design requires a real horizontal price-bin calculation in the existing renderer, explicitly estimated from qualified loaded bars; it must not claim observed trades at each price, aggressor flow or liquidity.
- General AI language, editable automatic structure, currency/capital/sizing-aware research, benchmarks and deeper attested history remain incomplete.
- Five-second first navigation, large-chart frame budgets, larger workspaces/cloud sync and matched TradingView/MT5 speed comparisons remain open. These functional checks establish no faster/instant claim.
- Actual provider entitlement, market availability, broker results, native-terminal acceptance and deployment remain separate.

At report creation, Replit's preceding source import (`677241aa`, saved `41934a4c`) is still reported busy; this newer source has not yet been submitted. Do not equate a local/GitHub checkpoint with visible or activated Replit code. Preserve the currently running API and its bundle.

No main merge, publish, deployment, existing database change, operational worker, email, live/demo broker test or trading activation occurred.

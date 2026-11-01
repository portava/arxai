# Smart Chart price and time ruler — 1 November 2026

Status: **locally validated feature increment, not release-green or competitor parity.** Application/tested source `4357a358e31475650204e5ca24bd42626dcd4779`; ordinary production-runtime offline Scanner fixture `31a2d5ad9d8cbc46`. Base `c9b3c6e215937a10b803217e22c3ebfbaf23bff4` includes accepted multi-chart and interval-following work. The failed compact-initial startup experiment and other held branches are excluded.

## User behavior

Choose **Price and time ruler** in Drawing tool, then click or tap two candle positions. The plot shows a diagonal, dashed horizontal/vertical guides and a compact two-line readout. Direction runs from the first selected point to the second: signed price difference, percentage relative to the first price, and absolute elapsed calendar time. A backwards selection says “earlier.” Two different prices on the same candle are allowed and correctly show zero elapsed time.

These are selected price coordinates, not necessarily candle closes. Magnet retains its existing OHLC snapping behavior. Log, inverted, percentage, indexed and Heikin Ashi display modes do not turn measurement values into screen-space differences or transformed candle prices. Calendar duration includes closed sessions; no bar count, profit, pip/tick distance or volume is inferred. Extremely large ratios report percentage unavailable rather than Infinity.

The existing drawing workflow provides two editable handles, exact price inputs, colour/width/style, hide/show, locking, deletion, undo/redo and browser persistence scoped by symbol/interval. Objects exposes the full measurement text and its meaning. Compact on-canvas labels stay inside the plot and are clipped rather than extending over controls; very narrow plots omit the label, with the full readout retained in Objects. All market/source and execution gates remain unchanged. This is an explicit analysis annotation, not an automated signal or trade.

## Exact-source validation

- Frontend **2727 pass / 0 fail / 11 skip**, 181 files pass and 1 skipped. Eight new tests cover directional arithmetic, elapsed time across closures, same-candle ranges, tiny changes, invalid/extreme inputs, projection invariance, geometry/hit targets, persistence/edit/undo and partial-placement cancellation.
- Domain build, dashboard typecheck and production build pass. **87/87 guards**, **7/7 bindings**.
- Actual Scanner browser acceptance **23/23** on the tested commit: exact canonical/display OHLC equals the selected source response; real pointer placement; actual rendered labels/segments/handles; accessible text; editing and undo; hide/lock; scale and Heikin Ashi invariance; full reload; phone touch same-candle placement; no horizontal document overflow; engine continuity after reload; unchanged canonical candles; no page exceptions or order/confirmation attempts. Desktop and phone screenshots inspected.
- Self-review only. No independent reviewer, API/backend/database, real provider, live/demo broker or owner-published-app acceptance is claimed.

The first browser session closed before page assertions; two setup attempts could not find it. A replacement session reached 16 passing assertions before the reload assertion failed. The expected object omitted `locked:false` after an explicit unlock; actual saved anchors were correct. The test expectation was corrected to require the explicitly unlocked state and rerun in a fresh session. Original failures remain in the receipts. One initial test-file append used the wrong working directory and failed; the subsequent full suite includes the intended tests. The earlier focused 46-test result predates those two workflow additions and is not substituted for final full-suite evidence.

The synthetic fixture deliberately returns unavailable responses for unmodelled endpoints: the final browser receipt retains 67 unknown endpoint occurrences and 75 console resource errors, with zero page exceptions. This does not establish full application/API health. The rendered feed remains explicitly unavailable/invalid and analysis/trading disabled.

## Measured interaction

After all owned builds/tests finished, measured 20 planned second-anchor clicks in a fresh browser: five at each viewport/CPU condition. All 20 recorded, trusted, valid and within the unchanged 100ms interaction target. No samples or outliers were removed.

Completion requires actual non-dirty ruler geometry and its two readout lines, unchanged exact canonical/display data and engine identity, an unobscured plot at least 100px in each dimension, and two consecutive rendering frames. Timing starts at the trusted pointer-down event, not before actionability polling. The first point is already placed and data is loaded; this is **cached drawing completion**, not cold entry or startup. Five samples per condition do not establish a population p95. CPU throttling changes frame alignment; the smaller 4× numbers do not prove slowed hardware is faster.

| Condition | Median ms | Maximum ms | ≤100ms |
|---|---:|---:|---:|
| Desktop 1440×1100, normal |31.6|32.0|5/5|
| Phone width 390×844, normal |31.4|31.6|5/5|
| Desktop, 4× CPU |26.9|28.5|5/5|
| Phone width, 4× CPU |27.8|30.2|5/5|

This is not a physical GPU-paint timestamp, a real phone, a live feed or a matched competitor runtime. Host-wide quietness is unknown. Scanner first-load failures, earlier stress failures and all held experiments remain open; this feature does not resolve them. No new startup speed claim is made.

## Competitor reference and remaining scope

TradingView documents separate price/date tools and a combined date-and-price tool, including configurable statistics, pip/tick and volume options. ARX now covers editable two-point price/percentage/calendar-time measurement; bar-count and trustworthy pip/tick/volume measurements, extended styling and equivalent drag gestures remain gaps. [TradingView official measurement documentation](https://www.tradingview.com/support/solutions/43000516996-date-and-price-range-drawing-tools/), read 1 November 2026 UTC.

MetaQuotes' indexed official documentation describes crosshair distance measurement in its web and Android products. The full pages timed out during this turn; this is limited source evidence, not a fresh runtime comparison. [MetaQuotes web-terminal release note](https://www.metatrader5.com/en/releasenotes/terminal/2368), [Android charts documentation](https://www.metatrader5.com/en/mobile-trading/android/help/chart). Existing broader TradingView/MT5 research and unresolved catalogue, workspace, calendar, volume, replay, alert, stress and accessibility gaps remain in the competitive scorecard. No parity or completion percentage is assigned.

## Reproduction and handoff

Checked-in functional and timing runners: `scripts/scanner-qa/shared-chart-range-ruler.js` and `shared-chart-range-ruler-timing.js`. Inject `SCANNER_QA_EXPECTED_COMMIT` with the intended fixture source. Optionally set `SCANNER_QA_OUTPUT_DIR` for screenshots. The portable copies only parameterize the exact-source check and output path; application validation ran on 4357a358. Build the ordinary shared Scanner fixture, serve its returned ID on loopback and install the retained offline setup in a fresh browser. It intercepts API requests and blocks external traffic, writes and streams. Do not use these fixtures against a broker or production database.

Raw evidence: `/Users/areyouok/arx-tier1-release/chart-range-ruler-20261101`. Portable compressed receipts and verified hashes: `docs/validation/chart-range-ruler-20261101/manifest.json`. All owned test browser/fixture processes were stopped after acceptance.

A later read-only check confirmed the earlier Replit multi-chart/interval-following import completed, clean with no newer tracked changes: application `a861d94a7e83618aef531203c849e9555b2ab5f8`, checkpoint `65581561a7efe21b674685da0dea2b72ed87d87b`, recovery `240db58bece906d00b5cba0e7351a85ec9a5be7e`, branch `codex/pr103-smart-chart-development-20261031`. Connector-reported checks: frontend2717/0/11, pure API76, scheduling13, recorder22, guards87/bindings7, follow browser39 and multiview23 (overlapping); typechecks/both builds pass. Two initial harness failures and a corrected wrong-state control-order diagnosis remain retained. Only partial plot visibility was recorded; a mobile 13px post-interaction scroll is not cold-navigation acceptance. Instrument-picker interaction, new calendar browser acceptance, rapid response races, storage-denial integration and real-owner/provider/device checks remain open. No new performance measurements; previous 0valid/1invalid/9unstarted navigation,1393ms readiness239.3ms completion, earlier invalid batches/zoom timeouts and large-chunk warning remain. Raw remote receipts were not independently inspected. The full connector response is retained in replit-completion.json.

This ruler is prepared for the next selective development import; preserve the current Replit source and concurrent work, and validate the exact combined source separately. API activation remains deferred. No main merge, publish/deploy, existing database change, worker activation, email, funds movement or broker test occurred. Next work includes first-load layout/render investigation, sustained drawing/multi-chart stress and further evidence-backed charting gaps.

# Scanner first navigation — 31 October 2026

Owner report: the first Market Scanner click after reload takes about five seconds. This work targets that first visit, not only repeat navigation. No production performance or completion claim is made.

## Changes

`df4e0161e3de580bc5550c23cbbda7f1c6db0b8b` prepares the route code during browser idle time for users whose navigation permits Scanner. Hover, keyboard focus, pointer-down and navigation start the selected market's existing candle query concurrently with the route import. Sidebar, mobile navigation and command palette use the same import promise and QueryClient cache. Requests retain the existing symbol/timeframe/count identity, original provider evidence and five-second freshness budget. Idle work fetches code only; it does not mount the Scanner, poll, open streams, request positions, or trade. Hidden documents and data-saving connections skip speculative idle imports. Denied roles do not warm the route.

`a6147137c9da303c33422d8895a42475889f6b8d` removes the Scanner's dependency on the outer router Suspense reveal. An already-loaded module renders synchronously; a cold visit gets a local loading shell that is replaced as soon as the module resolves. Leaving the route cancels its state update, and import errors still reach the error boundary. Other routes and authorization gates are unchanged.

The chart-symbol storage reader also tolerates unavailable browser storage, since the navigation preparation now consumes that shared selection outside Scanner.

## Measured results

Same offline production fixture, desktop browser, synthetic EURUSD M15, 200 bars, intentionally delayed candle response (80 ms). Each sample fully reloads the home document, waits only for the Scanner link to be visible, then clicks it without an intentional hover dwell. Five samples per row. Timing starts at the captured click; the end is the correct series installed plus two animation frames. Full canonical and displayed OHLC are compared with the intercepted response outside the timed region. These are rendering opportunities, not hardware paint measurements.

| Source / fixture | Median click → completed series + frames | Range | Samples below 100 ms |
| --- | ---: | ---: | ---: |
| Baseline `0af7ebd7` / `17c30394fc267357` (application `1a4fa6d7`) | 460.1 ms | 447.1–463.4 ms | 0/5 |
| Early-query change `df4e0161` / `212ca7178deceb96` | 364.4 ms | 345.2–366.1 ms | 0/5 |
| Final `a6147137` / `9841d8a56acf12c1` | 129.9 ms | 128.4–143.3 ms | 0/5 |

Final chart-container observation: 34.7–37.6 ms after click. Final bars installed: 103.9–110.2 ms. The immediate-click completed-series result still misses 100 ms. Cold remote requests, active automatic analysis and a production host can take longer. Do not call this instant loading, a measured fix of the owner's five-second delay, or TradingView/MT5 parity.

All final samples match the response's OHLC, including rendered series. No page exceptions or unexpected writes/external requests occurred. Expected background POST attempts were denied with 503 by the offline fixture; all unknown API reads also remained unavailable. No broker connection or live/demo order was used. Unknown-read errors are retained in the raw browser reports.

## Validation on final application commit a6147137

- Full frontend: **169 files; 2,417 passed, 9 skipped, 0 failed**.
- Frontend typecheck and production build passed. Existing sourcemap/large-chunk warnings retained.
- **87/87 guards** and **7/7 binding assertions** passed.
- New tests cover cache sharing with a mounted reader, cache expiry without timestamp inflation, denied access, changing interval with blocked storage, unavailable intervals, request failures, idle constraints, immediate prepared rendering and leaving during import.
- Final screenshot inspected. Historical/unavailable truth remains visible; the fixture does not claim live analysis.

Failures retained: first full test run had four failures in two standalone navigation test fixtures lacking the newly required query context. One fixture now supplies its real QueryClient; the text-only assistant-name fixture mocks the separate preparation hook. Assertions were not removed. A first timing-tool run wrongly rejected the fixture's known blocked background calls; classification was corrected while all writes remained denied. An intermediate baseline was rerun in a fresh browser to eliminate accumulated timing listeners. Those diagnostic runs are not the accepted baseline above.

## Replit state and remaining acceptance

The owner supplied the published `arx-ai-baseline-import.replit.app/market-scanner` link. That URL redirects this browser session to sign-in. Subsequent read-only inspection found the signed-in Scanner inside the **Replit desktop development preview**, at the observed `*.pike.replit.dev` address. It visibly contains the shared chart, interval menu, templates, zoom/pan and automatic analysis. The existing Replit import targets PR103 `9d3b3ea8`, not the new loading fixes.

Replit Agent is still performing authenticated desktop/mobile checks for that existing import. Its visible report says final frontend typecheck, build, corrected tests, catalogue and disclosure checks passed; exact final workspace commit and consolidated receipt remain pending. Do not duplicate or interrupt that import. The connector remains busy. The new navigation commits still need a coordinated development-only sync and measurements on the actual served build. Published deployment has not been changed or authorized here.

Raw logs, benchmark wrappers, source manifests, failed runs and screenshot: [navigation receipts](validation/scanner-smart-chart-20261031/navigation/manifest.json). Local originals: `/Users/areyouok/arx-tier1-release/scanner-navigation-20261031/`.

## Subsequent development handoff

Replit confirmed the prior import saved clean checkpoint **e62483f047687956386ede7872538463dcbee4dd**, branch `codex/pr103-smart-chart-development-20261031`. The initial full run was 2,400 passed / 2 failed / 9 skipped; corrected affected tests passed 8, catalogue rerun passed 400 and disclosure checks passed 6. Typechecks/build passed. There was no wholesale full-suite rerun after those corrections; overlapping reruns must not be summed. Browser limitations above remain.

The tested first-navigation commits were then submitted as a separate development-only follow-up, existing Replit turn `fabb7c9c-fa80-41cb-8714-1e5066b998e6/01a16919-d9a3-70b8-8aa4-ebf6df24c53e/01a192ca-1451-70cc-b174-5adc1c52c8a9`. The connector reports **updating**; exact resulting source and real-preview timing are pending. No duplicate import should be queued. This does not update the published app.

## Final Replit outcome (supersedes pending status above)

Read-only connector retrieval confirmed clean development checkpoint **619f259db5f265a379190de42ff39fa5f876c768** on `codex/pr103-smart-chart-development-20261031`; recovery checkpoint `e62483f`. Only the two navigation commits were imported. Actual workspace checks: **2,412 passed / 9 skipped / 0 failed**, 169 files; typecheck/build, 87 guards and seven binding assertions passed.

**Immediate-first-click acceptance did not pass.** Six original V75/M15 samples showed controls at 251.7–287.3 ms and an OHLC/canvas candidate at 672.5–799.4 ms, but clicks occurred 27–55 seconds after reload and candles were prefetched. These are not cold-click or verified paint measurements. D1/M3 pixel verification was late, and conflicting D1 screenshot-budget claims remain unresolved.

The bounded desktop correction was blocked by the Welcome dialog and produced no Scanner click/candle GET. The mobile correction clicked about 8.2 seconds after reload (676.5 ms after navigation readiness) and failed to capture required scroll/paint marks. All eight records remain. Exact first fresh-candle paint and completed server analysis remain unverified. Candle GETs of 319–400 ms do not establish the cause of the owner's five-second delay.

Replit is now idle; do not poll the old job as though still live or repeat the same broken measurement method. Next work must repair the first-click harness/onboarding handling and obtain a timed, source-correct completion witness before more performance claims. Full remote artifacts remain in `generated-artifacts/arx-scanner-navigation-validation/`; report `ARX_SCANNER_NAVIGATION_SPEED_UPDATE.md`. Local connector receipt: [final report](validation/scanner-smart-chart-20261031/navigation/replit-final-report.json). The published app was unchanged.

## Strict primary-navigation and mobile first-view follow-up

See [Scanner mobile first view](SCANNER_MOBILE_FIRST_VIEW_2026_10_31.md) for source9ebb687a, a stricter in-page readiness/click witness, retained method failures, and the mobile below-fold repair. Final5desktop/5mobile samples are source-correct and visible but all miss100ms (medians115.4/115.7ms with fixed80ms data). This is separate evidence from the earlier navigation method and does not establish Replit/real-provider acceptance.

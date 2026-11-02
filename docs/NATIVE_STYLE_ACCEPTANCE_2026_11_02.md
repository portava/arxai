# Native chart style access and acceptance — 2 November 2026

**Scoped mobile usability repair accepted offline. Trusted style-switch latency and competitor parity remain unproven. Release remains not green.**

Application and native harness: `4823d180` (immutable production fixture `b5fa1e5c65e960a1`). Earlier failed pilot: `5ca9bb66`, fixture `25dcdf85d68f90fb`. QA-only disclosure witness follow-ups: `e96be0b0`, `f46da6af`; application/library bytes are identical to `4823d180`.
Branch: `codex/native-style-acceptance-20261102`.

## What changed

The existing single Style selector now remains beside the primary zoom/pan controls when advanced tools are collapsed. Previously, opening advanced tools on a 390×844 viewport pushed the plot entirely out of the visible area during style selection. The selector keeps its controlled preference state, accessible label and original-price explanation; no parallel chart or preference system was added.

All seven native styles were exercised on the actual Scanner route with historical synthetic EURUSD M15 bars: candles, bars, line, area, baseline, Heikin Ashi and hollow. The check requires exact canonical OHLC and displayed series, unchanged source/symbol/interval/viewport, a completed current native draw, two consecutive successful frame observations and a visibly intersecting plot whose midpoint hits the actual canvas. The HA display uses an independent formula oracle; original prices remain canonical.

MT5 documents candles, bars and line as its standard presentation types ([MT5 chart help](https://www.metatrader5.com/en/terminal/help/charts_analysis/charts)). TradingView describes HA as averaged prices rather than actual prices and publishes its recurrence ([TradingView HA help](https://www.tradingview.com/support/solutions/43000619436-understanding-heikin-ashi-charts/), rechecked 2 November). ARX's initial HA seed remains its documented convention, not proof of identical vendor history or values. Seven styles do not establish broader platform parity.

## Exact validation

| Check | Result |
|---|---|
| Full dashboard suite on `4823d180` | 4,715 pass, 12 skipped; 268 passing files / 2 skipped |
| Dashboard typecheck and production build | Pass |
| Immutable fixture build | Pass; clean and unchanged source |
| Actual Scanner programmatic transitions | **84/84**, across desktop/mobile and 1x/4x CPU; 28 recorded plus 56 warmups |
| Completion negative controls | Six rejections per condition: pending draw, wrong style, wrong source, changed canonical data, stale draw count and opaque child overlay |
| Independent source review | Clear after fixing the canvas visibility witness; final six hashes and QA follow-up hash match |
| Source guards | **85/87**; normalized failures identical to previous sizing checkpoint |
| Three supplemental guard tests | Pass |
| Existing latency-harness tests on final QA follow-up | **16/16** |
| Browser captures | 14 screenshots; mobile HA and desktop hollow/candles visually inspected |
| Trusted style latency / live market / broker / deployment | Not accepted or performed |

The UI regression test first failed because Style was inside the collapsed subtree (50 pass / 1 fail). After moving it, the test's original static preference fixture could not reflect a controlled selection; the corrected stateful fixture passes. Both failures are retained. A subsequent old-harness unit test needed real element geometry on its test double after Style moved; initial 14/15 and corrected 16/16 are retained.

## Timing limitation and retained failures

The first trusted-input pilot failed: desktop native select changes never committed, and mobile lacked visible plot intersection with tools expanded. Separate probes tried focused and clicked selections, arrows, Enter, Tab, Space and native-menu combinations. A plain dropdown on an otherwise blank browser page also did not commit with arrows/Enter. Key events were trusted and not default-prevented. This supports an environment/input-driver limitation; it does not establish that ARX dropdowns work on every browser.

The successful rerun explicitly uses programmatic selection and returns `FUNCTIONAL_PASS`, with `performanceAccepted:false`. Its recorded times are diagnostics only. They cannot replace missing trusted-input latency, support a sub-100ms claim or erase the earlier renderer's failures. The harness does not automatically turn a failed trusted run into a performance pass.

The first screenshot pass timed out while reading a hidden desktop disclosure through a visible-role locator. The corrected CSS lookup completed all fourteen captures. That failure is retained too. Offline expected 503/console diagnostics remain in the network logs; no clean-console claim is made.

## Receipts and open work

Raw: `/Users/areyouok/arx-tier1-release/native-style-acceptance-20261102`.
Archive: `/Users/areyouok/arx-tier1-release/native-style-acceptance-20261102.tar.gz`.
SHA-256: `2851b66f14a052e2f42d53b94add0fdeb500d85611be5d7446ecc6a313c6cee7`.

Current native style user-input latency remains to measure with a working native-select driver. First navigation under throttling, richer chart/comparison/study/drawing capabilities, calendar intervals, replay workloads, account/source/clock evidence and broader engine accuracy remain open. Tests do not prove every glyph/pixel, every device, a live feed, or TradingView/MT5 parity.

All owned browser sessions and fixture servers exited. No main merge, deployment, Replit sync, existing-database changes, worker/trading enablement, broker tests, funds or emails.

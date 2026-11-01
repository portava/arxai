# Smart Chart finding explanations and price labels — 1 November 2026

**Bounded UI change validated offline; ARX remains not release-green. Replit is unchanged.**

Application commit: `f079af0af7b460e51aa5afdf1f56b2809c890997`. QA correction: `fea74f36006071f405f1aa4f9fffdc2fa8538522`. Base: `b3bee175f368a31f003aa9f7f13b7ebbc68e180a`. The application trees are identical between the application and QA commits. This report does not transfer results from older ARX releases to these commits.

## Problem and resulting behavior

The owner's M15 and M30 screenshots showed two overlapping last-price labels, crowded pattern text, and a server explanation saying no pattern/trendline was named while the chart drew findings. A source-clock warning also disagreed with live/full-read status; that earlier status work is documented in `SCANNER_SCREENSHOT_TRUTH_2026_11_01.md` and is already in this base. None of these local improvements is installed in the running Replit preview.

This change keeps one explicit canonical last-price line and numeric axis label across all seven chart styles. Native series last-price labels are disabled. Heikin Ashi still uses the actual canonical close for this label, not a transformed close. Stale/unqualified live state removes the live-price affordance. The redundant in-plot “Last” title is gone.

Automatic annotation text is bounded to the plot and tries nearby positions before omitting a crowded label. Anchor prices, timestamps, guide lines and pattern geometry do not move. At most three labels are drawn; this avoids the annotation's own labels and anchor points, not every candle, drawing or external overlay. The existing suppression of secondary structural markers while a selected automatic annotation is shown is verified.

The existing chart reader now provides the selected finding to the existing assistant. **Explain this finding** and **explain this pattern** use the same getter. It checks the mounted pane, source identity, current reading and applied visible OHLC before responding. An explicit selection that disappears is not replaced silently. Hidden annotations, historical context and an unverified source clock remain disclosed. The answer names the finding's status, observed time, anchor prices and limitations. Source fingerprints stay in the binding rather than the user-facing answer.

This is deterministic local chart evidence, not a new AI detector or a remote model call. It does not establish agreement with the separate server assessment, calibrate a probability, predict profit or authorize entry. Manual/protective trading gates and the unapproved AI confidence policy are unchanged.

## Verification

| Check | Result and source |
| --- | --- |
| Full dashboard tests | 3,580 passed, 0 failed, 11 skipped; 217 files passed, 1 skipped. Application source identical to `f079af0a`; run immediately before committing it. |
| Focused selected-finding tests | 303 passed; included in the full total, not additional coverage counts. Before-fix failures retained. |
| Focused labels / reconciliation | 88 and 58 passed; also included in the full total. Before-fix failures retained. |
| Dashboard typecheck and production build | Passed. Sourcemap diagnostics and bundle-size warnings retained. |
| Guards | **85/87**. The same 38 wording matches and 3 internal-name/display matches as the base receipt; compared exactly. These remain open for contextual review. |
| Actual Scanner browser, generated M15 | 19/19 at `fea74f36`, immutable fixture `8e9b27e1ef3d206b`. |
| Actual Scanner browser, generated M30 | 19/19 on the same fixture, selecting the real M30 toolbar control. |
| Browser scope | Seven styles; canonical attached line; selected annotation; manual/typed agreement; hidden annotations; clock/source changes; desktop, 790-pixel and 390-pixel widths. |
| Independent source review | No remaining concrete blocker reported. Review is distinct from browser/measurement evidence. |

All browser responses were generated and intercepted. Incidental app startup mutation attempts were intercepted with HTTP 503; no real service, provider, model or broker was called. These tests do not reconstruct the owner's market candles or validate the actual screenshot patterns.

The first browser run retained 8 passing and 8 failing checks plus an input timeout. A QA observer incorrectly compared wrappers returned by `priceLines()`; library inspection showed each listing constructs fresh wrappers. The corrected observer compares the shared underlying options object and records every attached line. The fixture's overly broad mutation assertion and assistant-open hydration race were corrected without relaxing product expectations. The first M30 attempt used the wrong accessible name; that failure and the corrected run are retained.

## Measured performance

Local selected-finding clicks were timed from the captured click event to the new assistant answer in the DOM, then two animation frames. Each condition has 3 warmups and 24 measured samples. Answers were checked for the observed selected shape. All samples and maxima are retained.

| Viewport / CPU throttle | DOM p95 | Two-frame p95 | Two-frame maximum |
| --- | ---: | ---: | ---: |
| 1440 px / 1× | 8.9 ms | 29.3 ms | 29.5 ms |
| 1440 px / 4× | 64.7 ms | 81.2 ms | 81.5 ms |
| 390 px / 1× | 4.4 ms | 31.5 ms | 31.7 ms |
| 390 px / 4× | 17.7 ms | 28.8 ms | 30.3 ms |

These samples meet the local interaction p95 <100 ms target in this environment. The phone layout has a smaller conversation view, and frame-phase differences affect the two-frame duration. This is not first-navigation latency, a remote AI response, physical paint, 60 fps proof, network or execution latency.

The existing adapter benchmark compared the exact base adapter from `b3bee175` with the candidate, using the same current dependencies and generated 500-bar workload. This is an adapter-only source override, not a full historical application build. Four runs were ordered baseline 1×, candidate 1×, candidate 4×, baseline 4×. Each passed 42 correctness checks and retained 336 measured samples plus 56 warmups across seven styles and four update scenarios.

| Adapter / CPU throttle | CPU p95 | Two-frame p95 | Two-frame maximum |
| --- | ---: | ---: | ---: |
| Base / 1× | 0.4 ms | 33.3 ms | 36.1 ms |
| Candidate / 1× | 0.4 ms | 33.0 ms | 33.7 ms |
| Candidate / 4× | 1.0 ms | 32.2 ms | 33.3 ms |
| Base / 4× | 1.0 ms | 32.1 ms | 32.9 ms |

There is no meaningful speed-win claim from these small differences. There were no concurrent task builds/tests or another task test browser during measurement; unrelated machine workloads were not controlled. Per-style/scenario results, browser version, exact source hashes and timing limitations are in the receipt.

## Competitive comparison and remaining work

TradingView documents [pattern labels with information on hover and alert conditions](https://www.tradingview.com/support/solutions/43000584462-automatic-candlestick-pattern-detection/), plus [pattern status and visibility controls](https://www.tradingview.com/support/solutions/43000706927-all-chart-patterns/). MT5 documents [analytical objects and their descriptions/properties](https://www.metatrader5.com/en/terminal/help/charts_analysis/objects). ARX now connects a selected finding to a plain-English local explanation. Hover explanations, equivalent pattern alerts, catalogue/detector accuracy and broader object interaction parity remain unproven. No direct vendor timing or accuracy benchmark was run.

Remaining gaps include global overlay collision handling, broader causal swing/breakout selection review, provider-authenticated time/freshness evidence, real Replit latency, and native terminal/broker validation. The separate server assessment can still differ from the selected local detector; the UI must keep their scope explicit. The owner's screenshots alone do not establish that a specific pattern or closed-candle breakout is valid.

No main merge, Replit running-source edit/restart, publish/deploy, existing database changes, worker/trading enablement, email, funds movement or live/demo broker test occurred. The architecture goal remains active.

## Receipts and reproduction

Portable evidence: `docs/validation/chart-label-finding-evidence-20261101/`. `raw-receipts.tar.gz` preserves all raw logs, scripts, generated screenshots, first failures, samples and warmups. `archive.json` records its checksum and size; every member was verified against `raw-manifest.json`.

Use the existing shared-chart fixture builder at `fea74f36`; normal mode builds the actual Scanner, `--feed=label-baseline` pins this round's base adapter, `--feed=candidate` uses current source. Historical `--feed=baseline` still pins its earlier reference. Serve the returned immutable build, and use the archived browser scripts with generated/intercepted APIs only. Preserve the recorded baseline/candidate pair and do not compare results from unrelated builds. The local dependency wrapper was `/tmp/arx-offline-run.py`; no package installation or dependency-source edit was performed.

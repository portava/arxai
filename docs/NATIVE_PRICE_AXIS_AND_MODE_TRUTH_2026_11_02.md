# Native price-axis controls and account-mode truth — 2 November 2026

**Development progress, not release-green.** Exact application commit:
`8feff8f094d3b64ed63f12ecd6eea1e503e07f9c`, based on `22f6b483`.
No default-renderer change, main merge, deployment, existing-database change,
worker activation, email, order or live/demo broker test.

## Competitive capability and acceptance

MT5 documents dragging the vertical price scale and double-clicking it to
restore scaling. TradingView's Lightweight Charts library exposes axis-drag
and double-click-reset controls. This library evidence is not a Supercharts
feature or performance equivalence claim.
[MT5 chart management](https://www.metatrader5.com/en/terminal/help/charts_advanced/charts_manage),
[TradingView library scale controls](https://tradingview.github.io/lightweight-charts/docs/api/interfaces/HandleScaleOptions).

ARX's native renderer now supports price-gutter dragging and vertical-only
double-click auto-fit. Manual bounds stay in real price units, including log,
percentage and indexed views. Source OHLC and the horizontal window do not
change. Incoming candles, horizontal navigation and resize retain the manual
range; incompatible source/style/scale changes restore auto-fit. Drawings,
overlays and inverse coordinates use the same price transform. Auxiliary-pane
and time-axis gutters cannot silently acquire price-axis ownership.

The existing Reset Scale button restores both vertical auto-fit and its normal
horizontal window. A captured adapter epoch prevents an interrupted reset from
navigating a replacement context. Second-pointer conflicts with drawing edits,
pointer cancellation, capture loss, window fallback, blur and destruction are
covered. Keyboard/screen-reader guidance describes the new price-axis gesture.
Horizontal-axis dragging and fixed one-to-one scaling remain open.

## Account-mode reporting

The global badge and Cockpit environment pill share a descriptive presenter over
the existing mode envelope and direct kill-switch query. Selected mode is shown
separately from paused/blocked/not-armed/unverified status or reported permissions.
They no longer call every block a disconnected bridge, equate Demo with a
simulator, or infer that all systems are operational from `LIVE_SHARED`.

A direct positive kill report takes priority. Failed/expired positive evidence
is explicitly last-reported; a successful authenticated false report clears it.
Missing restriction/preview fields and failed/stale reads cannot establish
availability. Browser HTTP caching is bypassed for both existing status GETs;
query keys, polling cadence and execution gates are unchanged. Simulated mode
describes the actual PAPER envelope rather than inventing trading-off status.

Component and real-query tests verify both consumers deduplicate these existing
GETs, retained errors, incomplete envelopes, scope downgrade and kill recovery.
The offline browser's frozen synthetic account now says `Account mode: Live
shared · Trading paused`, while the chart independently remains historical-only.
This is neither an instantaneous mode feed nor proof of broker connectivity.

## Validation and retained failures

| Check | Result on exact application commit |
| --- | --- |
| Full frontend | 4,566 pass, 12 skip, 0 fail; 260 files pass, 2 skip |
| Dashboard typecheck / production build | Pass / pass; existing bundle-size warnings retained |
| Guards | 85/87; same 38 wording and 3 internal-name findings after line/count normalization |
| Native targeted lane | 345 pass, including 26 new axis tests and adapter reset integration |
| Mode-focused lane | 26 pass; 58 neighboring checks also retained |
| Actual Scanner native QA build | `289059c945fbd0b4`, clean exact source, production/minified, immutable executed entry identity checked |
| Browser | 23 assertions pass, desktop and 390px DPR2 touch; no page exceptions or external feed/broker requests |
| Backend/database/root application CI | Not run; no backend product changes |

Focused tests overlap the full total. Before implementation, 18 axis and two
adapter-reset checks failed. Seven expanded drawing/second-pointer cases then
exposed a real capture-order collision; the early capture ownership guard fixes
it. Mode evidence retains 16 initial failures, three malformed-state failures
and the HTTP-cache regression. The prior exact-source browser build
`f4c99b711d36f38a`/`1ca81030` failed the actual vertical-gutter gesture. The new
browser run also verifies a changed price-to-pixel span, unchanged canonical
data/window, retained adapter, reset behavior and unrelated clock-refresh stability.

Initial typechecks failed because the new isolated worktree lacked generated
dependency declarations. These were built locally, then the final typecheck
passed. An attempted package `build` command had no script and is recorded as a
no-op, not a pass. No database operation was used to prepare declarations.

Independent design review was completed, and root reviewed the agent-authored
implementation and integration separately. **The final second-agent source
review was interrupted by an agent usage limit and remains outstanding.** Its
absence is not a passing review. All implementation/test/failure receipts are
preserved for that review; this checkpoint must not be presented as release-ready.

## Actual-app local interaction measurements

Synthetic 200-bar Scanner, native QA override, headless Chromium 156.0.8078.79,
1440×1200 viewport, Apple M4 Pro (14 logical CPUs, 24 GiB memory).
Heavy test/build jobs had finished. Each group retains five warmups and 60
measured trusted pointer moves. Measurement starts in the actual pointer handler
capture phase and ends on a later animation frame observing changed real-price
geometry and a new completed renderer paint. Acknowledgement is recorded
separately. These observations are not physical display scanout.

| Run / software CPU | Median | p95 | p99 / maximum | Failures |
| --- | --- | --- | --- | --- |
| 1 / 1× | 17.1 ms | 17.7 ms | 18.8 ms | 0 |
| 1 / 4× | 17.6 ms | 18.8 ms | 20.3 ms | 0 |
| 2 / 4× | 17.5 ms | 20.3 ms | 22.5 ms | 0 |
| 2 / 1× | 17.0 ms | 18.0 ms | 18.3 ms | 0 |

All 240 measured updates and 20 warmups are retained. This fixture meets the
owner's 100 ms p95 local completion target, not a universal 60 fps requirement.
Input-handler acknowledgement p95 is 0.1/0.3/0.2/0.1 ms in the same group order;
these early values are not substituted for completed rendering.
The previous version lacked the feature, so no speedup ratio is meaningful.
No competitor, broker/network, first-navigation, full-history or many-study
benchmark was performed here. The mode presenter retains shared request cadence;
its full-page rendering overhead was not separately benchmarked.

## Limits and next work

Lightweight Charts remains the normal renderer with genuine attribution. Native
all-consumer/default acceptance, synchronized multi-chart replay, deep history,
cloud layouts, remaining chart/tool types and actual Scanner slow-device
first-click failures remain open. The screenshots still show underlying page
text behind the fixed top strip while scrolled; whole-page layout is not newly
accepted. Other Truth surfaces have not been made unanimous by these two labels.

The owner's monetary requirement remains active. Earlier selected-account native
money reports, exact values and stale-response rejection are inherited unchanged.
Producer capture/order/clock/atomicity, process-local delivery, polling fallback,
remaining money consumers and measured terminal-to-screen latency still need
work. This chart interaction measurement says nothing about balance/P&L delivery.

Next: finish the independent review; cover all native consumers and remaining
navigation/scale features before a default change; continue the MT5 monetary
delivery and same-source Truth work. Keep the original owner brief and exact
evidence; do not restart or report parity/completion percentages.

Raw receipts: `/Users/areyouok/arx-tier1-release/native-axis-and-mode-truth-20261101/`.
Portable archive and SHA-256 manifest: `docs/validation/native-axis-and-mode-truth-20261101/`.
All owned test/build/browser jobs completed; both local servers were intentionally
stopped (exit 130). Nothing remains running as background validation.

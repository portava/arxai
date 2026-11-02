# Chart pattern continuity — 2 November 2026

Application: `a46d77f3b8f757c9eb97269926dd26640f589758`.
Base: `9bf1a081db90674b7a801e25290e1756a6ca522f`.
Branch: `codex/chart-pattern-continuity-20261102`.
Immutable actual-Scanner production fixture: `1009509ecf8c6f06`.

Verdict: scoped chart accuracy repair verified. Architecture completion, release acceptance and TradingView/MT5 parity remain unproven.

## Reproduction and resulting behavior

The chart's geometric detectors could treat separated observations as consecutive candles. A shooting star could acquire “next candle” confirmation across a missing interval, engulfing bodies could be joined across a gap, and a fitted trendline could bridge an unobserved interval. The window selector also silently removed unfinished interior bars. Five new tests failed on the base source; the prior 59 tests passed.

Existing detectors now run within uninterrupted observed segments. The original 600-bar bound, global 12-bar event/24-bar shape discovery windows, source identity and closed-candle boundaries remain. No new detector or invented candle was added. Descriptive metrics retain all observed candles and their explicit missing-interval limitations.

Earlier segment findings remain historical observations, with a typed marker carried into both ordinary and catalogue narratives. Later candles across a gap cannot establish their current state. The main explanation says “Before a time gap”; a visible notice outside the details disclosure explains the limitation. The same marker and caveat reach the manual assistant explanation. Genuine patterns entirely within the later segment still work.

Unfinished interior bars and overlapping fixed-duration candle intervals withhold the read. A gap can represent missing data or a scheduled market closure; this source does not establish which. Pattern continuity across a legitimate session closure therefore remains withheld until a suitable calendar contract exists.

## Validation and retained failures

- Initial reproduction: 59 pass, five new failures. Initial repair: 64 pass.
- Expanded targeted run: 292 pass, one failure. The old descriptive test allowed overlapping intervals; it was split to explicitly preserve observations across missing intervals while requiring a fully withheld read for overlaps.
- Independent reviewer found the catalogue narrative could discard the historical prefix. A typed marker and real Reader tests for both observed Doji and developing Shooting Star fixed it. Follow-up selected run: 211 pass. Independent earlier two-file run: 108 pass; final six-file source review clear, hashes matched.
- First full frontend run: 4,726 pass, one failure, 12 skipped. The existing Fibonacci test expected “Overlapping”; the shared refusal message now preserves that wording. This failed run is retained.
- Final full frontend: **4,728 pass, zero failures, 12 skipped**. Dashboard typecheck passed. Production dashboard build passed on the application commit.
- Source guards: **85/87**, with normalized failure lines identical to the preceding native-style checkpoint. The three supplemental guard fixtures pass. No full root/backend CI claim.
- Actual-Scanner browser: six functional cases at 1440×1100 and 390×844 (missing-next interval, historical Doji, uninterrupted confirmation). Each verifies applied canonical OHLC against the intercepted response, source identity, selected narrative and expected confirmation state. Final witness also checks that explanation/notice are onscreen and unobscured. All six pass; no latency acceptance is claimed.
- Browser attempts are retained: an exact-name locator missed the detail button's timestamp suffix; a prefix locator then matched several Doji observations. The final locator chooses the newest matching observation and independently checks its price. A subsequent DOM-only pass produced poorly framed screenshots; the final run closes details and verifies actual non-occlusion before capture.
- Six final screenshots captured; desktop missing-next and mobile Doji were visually inspected. The synthetic fixture retains unknown-API/503 console output and blocked network attempts; no clean-console or whole-page readiness claim. There were no uncaught page errors in the successful run.

## Reproduction and remaining work

Run the existing dashboard suite with `pnpm --filter @workspace/trading-dashboard exec vitest run`. Targeted files are `smartChartAnalysis.test.ts`, `SmartChartReader.test.tsx`, `smartChartNarrative.test.ts`, and `chartDescriptiveAnalysis.test.ts`.

Raw source hashes, before/after logs, reviewer receipt, full checks, synthetic browser script/runner, intercepted response evidence, screenshots and failed attempts are retained at `/Users/areyouok/arx-tier1-release/chart-pattern-continuity-20261102/`. The browser script embeds the existing shared fixture boundary and checks the exact application/build; it does not contact market or account services.

This repair affects the embedded chart reader. It does not prove that every separate server detector, Scanner assessment or AI conclusion agrees across all contexts. Broader source/account/currency/timeframe identity, stale balances/P&L, native trusted-input timing, throttled navigation, replay workload, calendar intervals and the competitive feature gaps remain open.

No main merge, deployment, Replit sync, existing-database changes, workers, trading or broker tests were performed. All task-owned browser runners and the fixture server were stopped after validation.

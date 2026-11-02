# Captured pattern source — 2 November 2026

Application: `6c89d9c040df12be73e5ff994408e31db453033e`.
Base: `891e3d3b468e473947b39ac661499515339b2c47`.
Branch: `codex/pattern-source-propagation-20261102`.

Verdict: provider context is preserved through the existing assistant and intelligence pattern paths. This is scoped offline correctness evidence, not all-engine accuracy, release acceptance or TradingView/MT5 parity.

## Changed behavior

The assistant's pattern and trendline readers, in both full and restricted modes, and the combined intelligence reader's three pattern children omitted the captured provider. They now forward `feedStatus.source` from the same captured context as their candles. Missing provider information stays null; another state label or a separate provider request cannot fill it in.

`RubyChartContext` already converts normalized candles to opening timestamps through `capturedAnalysisCandles`. The previous unknown-provider default happened to preserve that opening convention. Merely adding the provider would introduce a second conversion for legacy close-timestamp sources. The fix therefore carries an explicit internal `timestampConvention: "open"` through the existing producers and normalizer. Raw provider paths retain their existing convention when the option is absent.

This option specifies coordinates, not original clock authority. It does not mark a source UTC-verified, change completion thresholds, invent timestamps, strengthen a feed verdict or authorize execution. Existing original time-evidence checks remain separate.

## Validation

- Initial focused reproduction: **6 pass / 13 fail** across 19 tests. These are failed expectations covering provider propagation and prevention of a double conversion, not 13 separate product bugs. Fixed focused run: **19/19 pass**.
- Final captured-input lane: **73 pass / 0 fail / 0 skipped**, including the actual assistant full/restricted orchestration, actual intelligence composition with intercepted child inputs, direct normalized-window time bounds, no alternate primary fetch, and existing account/capture isolation cases.
- Related pattern, trendline, normalization clock-evidence, chart-truth and intelligence regression group: **228 pass / 0 fail / 0 skipped**.
- Independent review found no scoped blocker and independently reran the captured-input lane: **73/73 pass**. Exact reviewed source hashes are retained with its receipt.
- API typecheck and production build pass. The first typecheck caught an invalid test-fixture property (`state.source`); the fixture was corrected to the actual `state.truthState.source`, then typechecking and the captured-input lane passed. The failed log is retained.
- Source guards: **85/87**. The same two existing wording guards fail with 44 identical output lines after source-line normalization. All three supplemental guard fixtures pass separately.
- No full root CI, full frontend suite, browser, broker, live-feed or performance result is claimed for this commit. Earlier broad frontend/browser receipts belong to their exact earlier commits.

## Remaining findings

The intelligence session helper still infers named sessions from a candle timestamp without qualifying its original UTC mapping, and uses `synthetic_continuous` for missing/unparseable non-synthetic time. This was discovered in source inspection and remains open; it is not fixed by preserving provider metadata. Session/calendar qualification needs its own behavior and regression review.

Missing original clock evidence, source/account/currency identity across other consumers, calibrated AI confidence, real-time monetary display latency, native chart responsiveness and the documented competitive gaps remain unproven. Unknown source information is retained as unknown; this change does not add a new global execution gate.

Receipts: `/Users/areyouok/arx-tier1-release/pattern-source-propagation-20261102/`.
No main merge, deployment, Replit sync, existing-database changes, worker/trading enablement or live/demo broker tests.

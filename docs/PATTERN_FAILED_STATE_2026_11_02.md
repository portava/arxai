# Failed-pattern state consistency — 2 November 2026

Development-only correctness repair. Broad engine accuracy, launch readiness and TradingView/MT5 parity remain unproven.

Application commit: `140f9476fb5974a356fd0c57c36fc4845345d445` on `codex/pattern-failed-state-20261102`, parent `5f29c106725fa6744c668cd7fef963662dac87be`. Later documentation checkpoint does not change application source.

## Reproduced contradictions

1. The shared hammer detector exposed an invalidation level but still returned forming/buy when the next closed candle finished below that low. The existing source contract describes the hammer as the bullish counterpart of the shooting star, whose opposite close already marks failure.
2. Gold shooting-star and hammer helper wrappers could turn a failed underlying pattern into a conditional sell/buy when a key level was present, or merely wait when mid-range. Those helpers currently have only test invocation sites in the inspected repository; this is a foundation repair, not evidence that a production order path was changed.
3. Shared pattern reasoning could call failed/invalidated/exhausted patterns forming and offer the old level as a fresh confirmation trigger. A no-pattern result could also say already confirmed, or retain old directional text when represented as a status-none object.

The hammer counterexample follows five descending closes with open1.001/high1.0025/low0.982/close1.002, then a close0.975 below the hammer low. The old detector returned forming/buy55. The fixed detector returns failed/neutral, with the same failed-pattern cap20 convention already used by shooting stars. This is an internal rule weight, not calibrated probability or an approved AI-entry policy.

## Final behavior

Hammer failure requires a strictly lower next close. A wick below the low or a close exactly at it does not establish failure; a close above the high retains confirmation behavior. The detected historical shape and its levels remain available as failed evidence rather than disappearing.

Both Gold helper wrappers now return no_trade and conditional=false immediately for failed source formations, before key-level/mid-range handling. Valid key-level, feed, formation and conditional-only rules are unchanged.

The shared explanation gives failed, invalidated and exhausted state precedence in its decision, why, confirmation, invalidation and trader-test text. The previous trigger is historical context; new independently validated evidence is required for a new setup. Context-only qualifications remain explicit. Absent/status-none records withhold obsolete directional evidence, prices, warnings and failure-mode text; independent caller warnings remain.

The generic classifier, ranking, execution gates and trading permissions are unchanged. Failed-state truth flows through detectCandlestickReversals → patternTruthService → buildPatternLibraryRead, which marketIntelligenceService invokes. The actual deployed app and all downstream UI consumers were not browser-accepted in this slice. Automatic chart catalogue shape observations are separate from reversal-lifecycle findings; broader cross-consumer consistency still requires audit.

## Exact-source evidence

| Check | Result |
| --- | --- |
| Initial pattern regressions |8 fail /36 pass |
| Initial Gold regressions |8 fail /27 pass |
| Reviewer-found status-none regression |1 fail; corrected run53/53 |
| Final pattern-library suite |53 pass /0 fail /0 skip |
| Final pattern-Truth suite |26 pass /0 fail /0 skip |
| Final Gold suite |35 pass /0 fail /0 skip |
| Final Scanner child-input suite |9 pass /0 fail /0 skip |
| Full dashboard suite |4,714 pass /0 fail /12 skipped |
| Library/API/dashboard typechecks and both production builds |Pass |
| Guards |85/87; same43 baseline diagnostic/failure lines after source-location normalization |
| Independent source review |Clear; all five final file hashes match frozen source |

Regression cases include stale/fresh feeds, key-level/mid-range cases, strict close versus wick/equality, genuine confirmation, failed/invalidated/exhausted with and without levels, context-only wording, null detection, and status-none objects containing stale directional text and prices. The production library composition and reasoning builder are used directly. No browser, timing, real-feed, terminal or broker validation is claimed for this commit. Prior browser acceptance belongs to its earlier exact commit, not this one. Full release CI was not run.

## Remaining work and boundaries

Continue source-bound consistency across chart annotations, local reader, server pattern library, scanner status and AI explanations; do not equate model agreement with truth. Remaining work includes other pattern lifecycles, narrative price precision, native source-clock/report ordering and current-state proof, real-time account push and legacy monetary consumers, terminal-confirmed close before reversal, slow-CPU chart navigation and the full original competitor/owner feature inventory.

No main merge, deployment/Replit sync, existing-database change, worker/trading activation, broker/live/demo test, funds movement or emails. AI-entry confidence policy and execution authority were not changed.

Evidence archive: `docs/validation/pattern-failed-state-20261102/receipts.tar.gz`, hashes in manifest.json. Raw: `/Users/areyouok/arx-tier1-release/pattern-failed-state-20261102`.

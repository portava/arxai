# Primary chart startup while candles are pending — 31 October 2026

Status: **locally accepted partial performance improvement**. The slowed first-click100ms target remains unmet. No TradingView/MT5 parity, launch-ready or architecture-complete claim. No deployment or broker testing.

## Exact source

Application **db6cf42ff515a8be66ed802c6756c9ebd70c1a2a**, branch `codex/chart-pending-engine-20261031`. Base `5679ec5108b722c289f1a2e7f51c84ad5ca0d17a` contains accepted f9eb6c5d app plus isolated diagnostic tooling, excluding the held panel-mount experiment. Candidate clean ordinary-runtime fixture **6e93be0ba49b0fcb**. Baseline fixture **e960a2c81a4dd54a**, clean source **ca1685c2f216aa9abda29180919742dc0d0da2ad**, same accepted application as the base. Receipt commits change no application code.

## Change and limits

A primary chart with no valid candles and a still-pending initial query keeps its existing loading/controls shell without constructing an empty engine. The engine starts synchronously in the layout phase when valid candles arrive or the query settles empty/error. Existing engines survive later loading cycles; source/context reset and validation remain. Comparison scheduling stays unchanged.

The start callback belongs to the current mounted workspace, reads current symbol/timeframe/settings inputs and is cleared on cleanup. Linked views register once when the built engine generation reaches props; this avoids duplicate peer-range replay while supporting the late primary engine. A waiting context can bind without an adapter using the existing stream ownership mechanism. No trade, risk, account or data-authority gate is bypassed.

## Functional validation

On exact application db6cf42f: **2625 frontend pass /0 fail /11 skip**, 179 passing files/1 skipped file. Dashboard typecheck/build pass; **87 guards and7 binding assertions pass**. Domain declarations built first. Six new tests cover pending construction, focused tools, retained engine during later loading, empty/error recovery, leaving before response, current market selection and one peer-range registration (parameterized empty/error case counts separately). Existing tick, comparison and source-reset coverage passes. Focused chart trio before the final market-selection case:123/123.

Actual Scanner browser: **18/18 checks**, desktop1440×1100 and mobile390×844. Candle response held while study search is edited; no engine exists before release. After release, same input/query/focus remains visible and unobscured, all200 canonical AND displayed candle values equal the fixture response, and a real provider/source replacement resets the workbench while retaining engine identity. No document overflow/page exceptions. Screenshots visually inspected; mobile scrolls to focused control, not proof of simultaneous whole-chart visibility. Synthetic historical data remains visibly unavailable for trading/AI.

Self-review only; no independent agent review. Full backend/root/database lanes not rerun for this frontend change. Real providers, owner-authenticated app, physical-device input, full multi-chart browser acceptance and competitor timing remain unverified.

## Repeatable first-navigation results

Unchanged first actionable trusted click workflow, 150ms readiness budget, exact canonical/displayed source witness, viewport visibility/unobscured plot and two rendering frames,100ms completion target.200 synthetic bars with80ms candle delay. HTTP cache disabled by route interception; fresh documents, prepared browser resources, not cold browser-process startup. Serial runs with all owned builds/tests stopped. Initial order baseline4×,baseline1×,candidate1×,candidate4×; repeat with fresh browsers candidate4× then baseline4×. All60 samples retained and valid:20 normal-speed target passes,40 slowed target failures. Five samples per viewport/run; p95/p99=max within each run, not a population estimate.

| Run / viewport | Baseline median / max ms | Candidate median / max ms |
|---|---:|---:|
| Normal desktop |53.3 /53.5|52.0 /56.2|
| Normal mobile |49.9 /50.5|50.2 /50.4|
| First4× desktop |399.6 /423.4|350.6 /356.2|
| First4× mobile |366.5 /410.6|345.1 /401.0|
| Reverse-order4× desktop |396.2 /417.6|362.1 /388.8|
| Reverse-order4× mobile |360.9 /372.0|328.2 /329.6|

Slowed medians improve in both viewports in both orderings (approximately6–12%). Normal speed is essentially unchanged, with desktop maximum increasing2.7ms in this sample. Candidate401ms outlier is retained. This is a local controlled-CPU improvement, not instant loading, physical low-end hardware acceptance or evidence about Replit/competitor speeds.

## Retained failures

New tests on baseline:41 pass /5 fail before the implementation. First focused candidate run:122 pass /1 fail because the new test used a nonexistent loading test-id; changed to the actual existing loading text, then123/123 pass. Final added market-selection case included in full2625 run. First expanded browser equality check failed after four passes: actual displayed candle fields had a different JSON property order. Inspection showed all200 values equal; corrected the assertion to compare exact time/OHLC fields and lengths. Original failed attempt and diagnostic payload retained. Final18/18 pass. No assertion or data gate relaxed; JSON key order is not candle value correctness.

## Separate Replit completion

Read-only connector reports the previous accepted follow-up finished at application **ee4091166a4e909a0c0cf8cabb1eaa9f7dba8445**, checkpoint **b96382154517ae2acfd2a5267e5625d061d31472**, recovery **140121e380c3905eca67d6a0d72ffdd508bc45f9**. Frontend2617 pass/11skip/0fail; pureAPI76,scheduling13,recorder22,guards87,bindings7,offlinebrowser53 allpass; types/bothbuilds pass. Two browser harness failures and wrong-route404 probes retained/corrected; topbar symbol picker503 remains, separate Symbols-tab journey passed. No new navigation acceptance samples. Previous-source0valid/4invalid/16unstarted and older invalid/zoom-timeout evidence remain open; no remote speedup established. Frontend refreshed; API not restarted, so volume correction lacks refreshed-process acceptance. Raw remote receipts not independently inspected locally. This new pending-engine change has not been imported at report time.

## Evidence / continuation

All scripts/logs/JSON/images/journals preserved under `docs/validation/chart-pending-engine-20261031/manifest.json` with original/archive SHA-256 hashes. Raw folder `/Users/areyouok/arx-tier1-release/chart-pending-engine-20261031`. Owned local browsers and servers stopped.

Next: selectively integrate this tested frontend change into the completed Replit checkpoint, preserving concurrent work and obtaining exact combined evidence. Continue reducing proven startup cost without weakening source completion or delaying useful panels. Held experiments remain excluded. No main merge, publish/deploy, existing-database change, worker activation, funds movement or live/demo broker tests.

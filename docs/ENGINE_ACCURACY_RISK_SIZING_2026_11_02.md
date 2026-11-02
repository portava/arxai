# Engine accuracy: risk-sizing consistency — 2 November 2026

Application source: `4811828fea605124aba84f9db317a6c3f2bd7d1f`. Base checkpoint: `716c9845d513725ed8e9c9a7e8c255cfee8d1a1e`.
Branch: `codex/engine-risk-sizing-20261102`.

**Verdict: scoped arithmetic and consumer corrections verified offline; all-engine accuracy and release readiness remain unproven.** No deployment, main merge, existing database changes, worker enablement or broker tests.

## Verified corrections

The canonical risk sizer refuses a broker minimum that would enlarge the supplied risk budget. Preferred nearest rounding cannot cross the budget; caps remain on the volume grid. Non-finite inputs, arithmetic overflow/underflow, invalid bounds and unsupported step precision return no size with an explicit reason. Relative arithmetic roundoff tolerance is 1e-12 of the supplied budget, not an extra volume step or a financial risk allowance.

Pip sizing preserves the broker volume precision: the test case previously turned 0.015 lots into 0.02, increasing modeled stop risk from 1.50 to 2.00 against a 1.56 budget. It now returns 0.015. Risk amount is a budget, not a guarantee of actual loss; the approval-stage library's wording now says this.

API instrument-class and paper adapters no longer substitute a 0.01 minimum after a failed calculation. The instrument cap cannot round 0.015 upward to 0.02 on a 0.01 grid. A valid bounded result is not labelled unavailable merely because an unbounded diagnostic size is beyond numeric precision.

Scalp now consumes the canonical checked lot using its actual supplied volume rules; it cannot take the diagnostic raw lot and clamp it upward after refusal. Missing, invalid or sub-minimum sizing clears the build action and suggested money/lot values. An explicit zero, negative or non-finite risk request is refused, never replaced by the account default. Absence retains the pre-existing default/target-only planning behavior. Target-only planning is not account affordability or execution authorization.

## Evidence on this exact application commit

| Check | Result |
|---|---|
| Position sizing, including approval-library composition and equivalent-model adapter consistency | 27 pass |
| Scalp engine, including target-only, absent-budget and explicit-invalid-budget cases | 38 pass |
| Scalp add-on tiers / forced-zero / management / run-on | 21 / 14 / 15 / 23 pass |
| Paper intelligence offline source/skip contract | 2 pass |
| Mission agent / draft domain suites | 11 / 13 pass |
| Total selected backend tests | **164 pass, 0 fail, 0 skipped** |
| Shared-library, API and dashboard type checks | Pass |
| API and dashboard builds | Pass |
| Source guards | **85/87**, same 43 diagnostic lines as the base evidence after normalizing locations |
| Supplemental binding / selected-market / wording-source guard tests | All 3 pass independently |
| Independent review | Six final file hashes match committed source; scoped findings closed |
| Browser, frontend full suite, root full CI, broker/terminal/hosted app | Not run on this commit |

The first guard command failed before execution because the restricted environment denied its temporary process pipe. Its log is retained. The authorized rerun reached all 87 guards. The two remaining failures are `risky-wording-frontend` and `no-internal-names-user-ui`; they remain open, not waived. The runner retained an unchanged head and a clean tree throughout checks.

Reproduction records are retained: initial sizing suite 2 pass / 20 fail; independent numeric review 24 pass / 2 fail; consumer review 58 pass / 4 fail; explicit-risk case 37 pass / 1 fail. These counts are test cases, **not distinct-bug counts**. Failed intermediate fixes and reviewer probe launch failures are retained too.

Raw receipts: `/Users/areyouok/arx-tier1-release/engine-risk-sizing-20261102`.
Archive: `/Users/areyouok/arx-tier1-release/engine-risk-sizing-20261102-receipts.tar.gz`.
Archive SHA-256: `fdee0f2208542e39d09035956ef2a6be6c078487c6e503da96ebfe2b93f4740f`.
Manifest: `/Users/areyouok/arx-tier1-release/engine-risk-sizing-20261102-manifest.json`.

## Caller scope and remaining limits

- The API calculator is used by the risk route, mission previews/drafts and paper intelligence. Paper execution already refuses a non-positive capped size before its governed paper-fill call. This turn did not exercise the database-backed fill route.
- `runApprove` was tested as a pure library composition. No application caller of its `runPipeline` wrapper was found by symbol search; this is not proof of production dispatch behavior.
- The scalp service/Focus/Broad/Builder share `evaluateScalp`; only the pure engine and adjacent offline suites were exercised here, not deployed rendering.
- The instrument-class calculator still uses approximate class-based money-per-unit values and a synthetic 1s adjustment. This fix does not establish broker contract/currency conversion, native account ownership/freshness, commission, swap, slippage or gap-loss accuracy.
- Scalp money/margin are modeled estimates, with existing display rounding and missing-leverage fallback. They are not broker balances or guaranteed loss limits.
- No native MT5 money update latency, current-value equality, source clock ordering, or all-account push was proven here.
- A direct generic `clampLotToStep` call is not a risk authority. Scalp's bypass was removed; the generic helper remains exported.

## All-engine audit remains open

The raw `engine-inventory.json` enumerates 537 files ending `.engine.ts` under `lib/domain/src` only. This is a filename inventory, not a complete runtime map or an accuracy score. API brain engines, client calculations and dynamically composed paths require separate tracing. Do not call all engines audited or accurate from this list.

| Engine family | Evidence available / next required work |
|---|---|
| Risk, paper and scalp sizing | This scoped fix; verify actual broker specs/currency, rounded display money and downstream route refusals next |
| Chart patterns / market intelligence | Earlier exact-source candle identity and failed/absent-state receipts exist; local catalogue observations versus server lifecycle, price precision and UI snapshots remain to reconcile |
| Scanner / Truth / AI narration | Continue source/account/symbol/timeframe/window identity, staleness, conflicting evidence and downgraded-label consistency; earlier evidence is not a deployment proof |
| Broker money / cockpit / Fund Control | Earlier native-report display repairs; source ordering/current verification, other consumers and all-account push remain open |
| Self-trading / execution / protective management | Existing safety suites are not broker acceptance; Scanner reversal still needs terminal-confirmed close before opposite entry |
| Confidence / probability / Profit Mission | Audit score provenance and calibration separately. Read-only triage found `evaluateProbability` can upgrade confidence from sample count alone and `scoreStrategyEdge` uses wall clock despite a supplied context clock. These are follow-up candidates; not reproduced runtime fixes in this commit |
| News / sessions / multi-timeframe / indicators | Verify provider evidence, units, calendar boundaries and independent numerical oracles; no new acceptance claim here |
| Portfolio / research / backtest / learning and remaining modules | Runtime reachability, meaningful data requirements and independent tests remain to be mapped; no accuracy or completion percentage assigned |

Acceptance must come from independent evidence: matching facts carry the same source, account, currency, symbol, timeframe, window and observation identity. Different windows/estimates must be labelled; missing or conflicting evidence must stay unknown/held. Engines agreeing with each other is insufficient if they share a faulty input or calculation. No confidence scale or AI entry authorization was introduced.

# ARX Smart Chart / Truth / historical research — development integration

Date: 1 November 2026. Development source only. No release-green, first-navigation
speed, account acceptance or TradingView/MT5 parity claim.

## Exact source and recovery

- Branch: `codex/pr103-smart-chart-development-20261031`.
- Combined application: `625f9462c45d34400a2ff3e75db2f219b268be06`.
- Preserved recovery checkpoint: `124f5ccc9ecca97a07f2b27a15f9a85a1df8d23e`.
- Recovery ref: `codex/backup-before-chart-research-20261101`.
- Previous application retained: `4348fc6ae7cfbbdbdc527163ab18ee06416f47cd`.
- Upstream saved report head: `54280fc81500ef35b60c378d947314d507faf87a`.
- Upstream tested application: `4ad8a5aceb82483fdb35cf9fd747768e55aabf2e`.
- Upstream branch: `codex/chart-research-workbench-20261101`.

The final documentation/checkpoint commit is recorded in the adjacent ignored
`final-checkpoint.json` after committing this report. It does not change
application source.

Initial Git inspection was clean at the expected recovery checkpoint. No
concurrent tracked edits appeared during integration. This is a point-in-time
observation, not a cross-session editing lock.

## Selective reconciliation

The reviewed 167-path inventory and report were fetched at the pinned head.
Every downloaded target file matched its declared SHA-256.

Only 73 application, contract, test and required guard files were imported:
71 match the exact upstream target, and two retain local differences:

- `arxai/artifacts/api-server/package.json`: only the chart-candle test command
  changed. Existing test-command omissions/flags and the local Express pin were
  retained. No dependency installation or lockfile update occurred.
- `arxai/artifacts/api-server/src/routes/mt5.ts`: only the two candle evidence
  imports, candle map typing and per-bar tick evidence were added. The upstream
  base contains separate terminal-result/mailbox changes absent locally; those
  were not imported or allowed to overwrite the local route.

The 82 documentation/evidence files and 12 other tooling files are archived
under the ignored candidate directory, not installed into the normal runtime.
The existing recorder, fixture builder, witness and documentation remain
unchanged. The accepted no-live-execution guard extension is included.

All application paths are in the supplied inventory. Replit launchers, workflow
settings, credentials, authentication/sign-out, startup, dependency locks,
cockpit funds, existing chart/dock/layout/ruler work and prior recorder remain
preserved. No held toolbar, containment, resize-dedup, mount-budget,
compact-initial or other held performance branch was imported.

The import extends the existing chart, assistant registration, Truth evidence
adapter and causal research engine; it does not add a replacement chart,
assistant backend, simulator, order pipeline or account balance authority.

## Accepted behavior

- Bounded current-chart study requests use the existing study calculator and
  disclose actual calculated values with chart/source context. Unsupported
  language remains unavailable; this is not a general-purpose AI claim.
- Tick bars require explicit per-bar quantity semantics. Observed zero stays
  zero; missing/invalid/partial or ambiguous volume remains a gap. Tick counts
  are not traded size and do not authorize VWAP or volume profile.
- Directional Truth requires original matching source identity. Legacy responses
  without optional evidence remain capped/unavailable, not inferred.
- The on-demand historical workbench edits an EMA crossover/Wilder ATR scenario
  and uses the same shared engine for manual and language configuration.
- The selected simulated trade binds to the frozen source and ledger. Entry,
  exit and bounded stop/target references are historical overlays, not live
  positions or orders. OHLC exits retain interval uncertainty.
- A disposable browser calculation Worker is intentional local computation.
  It is distinct from operational API/settlement/trading workers, which were
  not activated by this update.
- Insufficient original closed history, unknown price basis, unsupported
  requests and missing evidence stay unavailable. No arbitrary two-year history
  is fetched or substituted with the current chart window.

## Automated checks on the combined application

All 11 serial commands completed with exit code 0, using a sanitized offline
environment and external-network guard. No existing database was targeted.

| Check | Pass | Fail | Skip |
|---|---:|---:|---:|
| Full frontend, 187 passing files / 1 skipped file | 2,950 | 0 | 11 |
| Backtest / causal V1/V2 / Profit Mission contracts | 158 | 0 | 0 |
| Truth component and producer evidence | 47 | 0 | 0 |
| Candle volume / shape / fixtures / forming-source isolation | 100 | 0 | 0 |
| Existing navigation recorder / disclosure regressions | 22 | 0 | 0 |
| Guards | 87 | 0 | 0 |
| Binding assertions | 7 | 0 | 0 |

Root composite libraries and all leaf typechecks pass. Dashboard production
build passes. API build passes **only into the isolated validation output**;
the running API bundle was not rebuilt or replaced.

The 305 backend tests are the actual selected combined-workspace count, not the
upstream 297 count. The local frontend count is 2,950, not upstream 2,952.
No upstream browser count, mutation-test count or benchmark is substituted for
local evidence.

OpenAPI generation ran successfully into an isolated ignored tree. Installed
Orval is 8.44.0; candidate headers name 8.5.3. Its output is not byte-identical
and isolated React Query detection warns that it defaults to v4 without the
original package context. Generated hooks from that run were not installed.
Only the scoped pinned contract/schema changes were accepted, preserving
unrelated local generated code and dependency versions.

Retained warnings include large frontend chunks, existing test React/key and
navigation warnings, expected offline unavailable requests, and a synthetic
market simulator startup inside the disposable mocked Truth test process.
That process exited; it was not the operational API service.

## Actual Scanner browser validation

Status: **incomplete browser acceptance**, not a clean pass. One initial harness setup failure and one corrected browser execution were retained. No further browser retry was performed.

- Initial attempt: variable shadowing caused a temporal-dead-zone ReferenceError before Chromium/navigation; zero application assertions ran. Its original script, summary and logs remain in functional/attempt-1/.
- Corrected execution: **8 assertions: 6 passed, 2 failed; 2 completed steps and 5 failed/unfinished steps**. There are no invented passes for unexecuted assertions.
- Pass observations: 240 contiguous closed/final source-qualified M15 BID fixture bars; explicit zero and missing tick evidence; actual native chart with 240 canonical bars; unsupported VWAP refusal without adding a study; manual EMA/ATR defaults 20/50/14 and 175 visible closed bars; all six mutation attempts returned 503.
- The two RSI assertions failed because the numeric parser included the trailing sentence period. At 2026-01-02T11:45:00.000Z the receipt/inspector showed 98.111917 and the native point was 98.11191710703028. They appear numerically consistent, but the recorded assertions remain FAILED, not retrospectively converted to passes.
- Tick histogram verification stopped on a probe-side flatMap of undefined. Two-year history, supported-language and unsupported-rule steps timed out waiting for expected assistant text. The missing-identity reload was intercepted by the open assistant dialog. Those outcomes are retained, not classified as successful application journeys.
- **Not verified in this browser pass:** actual tick histogram values/gaps; full manual/language engine equivalence; calculation/result/ledger; selected-trade overlays; edit invalidation; Worker lifecycle/close cleanup; insufficient-history refusal; missing-identity Truth withdrawal; mobile rendering. No research calculation Worker started (zero events).
- Runtime: native headless Chromium 152.0.7977.64; Node v24.22.1; Playwright resolved from the existing scripts package; touch-capable desktop context, service workers blocked. No new CPU-throttled acceptance run or host-contention measurement was made. No mobile run reached completion.
- 157 requests/responses, 6 blocked mutations, 56 unknown GETs, 62 console errors, zero page exceptions and zero failed-request events. External and WebSocket interception was installed before navigation; zero attempted external/WS requests were recorded. No manual trading, voice, remote analysis or order action was performed.
- The actual desktop screenshot exists and was visually reviewed: functional/research-desktop.png. It shows the Scanner/chart before research completion, not a completed research result or mobile acceptance. No mobile/completed-research screenshot exists.
- Owned fixture exited 0 and owned Chromium processes were closed. The tester confirmed port4199 closed. Its first broad process cleanup filter self-matched; targeted cleanup subsequently succeeded. A later shell port check could not run because ss is not installed; an additional read-only namespace check could not complete because /proc/net/tcp6 is absent. These secondary checks are not independent port-closure proof or browser acceptance runs; no further retry was made.

The browser harness shortcomings remain a blocker to complete acceptance despite green source-level checks. No source or readiness gate was relaxed.

Immutable ordinary-production Scanner fixture:
`ba3416f825b00070`, built from clean application
`625f9462c45d34400a2ff3e75db2f219b268be06`, source unchanged, production runtime
checked. This is the actual dashboard entry and Scanner, not a recreated
component or deployable production bundle.

## Development serving and API deferral

Only `artifacts/trading-dashboard: web` was restarted, once. Vite reported ready
in 433 ms; this is server startup, not Scanner navigation performance.
Anonymous `/login` renders; the unauthenticated identity request returns the
expected 401. This is not private owner sign-in acceptance.

Shared-router executable modules for the study assistant, volume evidence,
ARXNativeChart/workbench and source-bound Truth returned HTTP 200 with expected
executable anchors outside source-map payloads.

The existing API remains its old built/running source:

- PID 425, unchanged start time: 1 November 2026 04:00:53.
- Running `dist/index.mjs` SHA-256 unchanged:
  `95f11b8d8fa6bd95e62d34b756ff964e86813f97355e4d989d23421b86e2a3da`.
- New API validation output: `generated-artifacts/arx-research-validation/api-build/`.
- No API/worker start, restart or service-setting change was performed.
- Missing optional evidence from that older API must remain unavailable.
- Earlier volume correction refreshed-process verification remains deferred.

Existing API activity/polling and provider warnings were visible in pre-existing
service logs; this update did not stop or claim to suppress other sessions'
activity. Retrieved deployment logs also contained earlier startup/failure
records predating this integration; no deployment was requested or performed.
No production diagnosis or health acceptance was undertaken.

## Retained failures and limitations

- One bulk file operation exceeded its serialized byte budget after 51 imported
  files. It was resumed in bounded blocks; the final exact-source audit confirms
  all 73 selected files. No partial import is presented as the final result.
- An initial fixture bootstrap lookup used `main.tsx` instead of `main.ts`.
  Corrected before the single fixture build; no failed build was hidden.
- All upstream failures and limitations remain archived in the reviewed reports:
  marker typing, wording-sensitive assertion, mobile table correction and
  review corrections are upstream history, not new combined-workspace failures.
- Upstream research browser raw receipts referenced a local author directory and
  were not in the supplied Git inventory; those claims were not independently
  reproduced merely by downloading the report.
- No new first-navigation, cached-control, zoom or competitor benchmark was
  planned/run. No acceptance thresholds were changed.
- Prior navigation remains **0 valid / 1 invalid / 9 unstarted**, with 1,393 ms
  readiness-to-click and 239.3 ms source-correct completion. Valid median/max
  remain null, not zero.
- Earlier 0 valid / 4 invalid / 16 unstarted, forty invalid slots, sustained
  180-second zoom timeouts, slowed-touch, first-load and idle failures remain.
- Original 150 ms readiness and 100 ms fully source-correct visible completion
  gates are unchanged.
- Prior partial plot visibility is not whole-plot-above-fold acceptance.
  Earlier mobile overlap, M2 no-data, hydration, legacy 404, ordinary alert POST,
  picker/calendar/race/storage and other recorded gaps remain open.
- No authenticated real-user/provider/device or published-app acceptance.
- No durable experiment-save integration, capital/account-currency/sizing,
  general strategy language, tick/lower-timeframe fill simulation, optimization,
  broad history retrieval, VWAP or volume-profile completion.
- No main merge, GitHub push, publish/republish/deploy, existing-database changes,
  migrations, credentials changes, operational worker/trading activation,
  emails, funds movements, orders or live/demo broker tests.

## Evidence

Root: `generated-artifacts/arx-research-validation/`.

- `download-integrity.json`, `scope-audit.json`, `preservation-audit.json`.
- `candidate/docs/CHART_RESEARCH_WORKBENCH_2026_11_01.md`.
- `candidate/docs/development-sync/CHART_RESEARCH_2026_11_01.json`.
- `research-results.json` and `research-0.log` through `research-10.log`.
- `run.py`, `api-build-isolated.mjs`, `codegen.config.ts`, `codegen/`, `api-build/`.
- `fixture/`, `builds/ba3416f825b00070/`.
- `functional/` browser scripts, raw receipts, screenshots and verdict.
- `served-source-checks.json`, `served-*.js`, `anonymous-login-smoke.jpg`.
- `validation-summary.json`, `evidence-sha256.json`, `final-checkpoint.json`.

Large/generated evidence is intentionally ignored by Git and deployment.
The tracked report and recoverable application/checkpoint identify its source.

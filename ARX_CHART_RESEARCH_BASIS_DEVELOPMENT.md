# Original candle price-basis correction — development integration

Date: 1 November 2026. Source-only development update; API activation deferred.

## Source and recovery

- Branch: `codex/pr103-smart-chart-development-20261031`.
- Combined application: `7e597458afd4f3831d8fe75580334cfcc979c540`.
- Recovery: `f9d7ccee09790bc97abe2d063a6c10dae8d6902c`.
- Recovery ref: `codex/backup-before-research-basis-20261101`.
- Pinned upstream: `77359a70a61dcaf465fb19f917dbfed635ecd011`,
  branch `codex/chart-research-basis-20261101`.
- Upstream reference: `4ad8a5aceb82483fdb35cf9fd747768e55aabf2e`.
- Final documentation/checkpoint commit is recorded after commit in
  `generated-artifacts/arx-research-basis-validation/final-checkpoint.json`.

Initial branch/checkpoint/worktree matched the expected clean baseline.
No concurrent source edits appeared during reconciliation. No cross-session
editing lock is claimed.

## Reviewed selective change

The pinned comparison contains 30 paths: 26 source/contract/test paths and four
documentation paths. Only the 26 source paths were imported; two evidence
reports were archived separately. Downloaded contents were checked against
their Git blob identifiers.

24 selected source files exactly match the pinned target. Two were reconciled:

- API package: only the targeted test command was extended, preserving local
  test flags/omissions and the Express pin.
- MT5 route: only original price-basis evidence ingestion and explanatory
  comments were added. Existing local terminal-result/mailbox differences were
  not replaced.

All changed application paths are in the reviewed comparison. Authentication,
sign-out, Replit launchers, startup, safety/Truth gates, funds, dependencies and
lockfiles, existing chart/dock/ruler/layout, prior recorder and research engine
were preserved. No automatic Fibonacci or held performance branch was imported.

The existing producer/normalizer/Truth and research capture/binding authorities
were extended; no replacement system was built.

## Evidence rule and producer limitation

Historical cost research now requires matching original per-bar
`producer_declared` BID/MID evidence. The frozen snapshot retains that evidence
and the binder rechecks it against current original candles. A provider name,
asset-family compatibility label, numeric cache row or old snapshot cannot
qualify it.

Supported lower-case declarations can be retained through authenticated MT5
ingestion in source. Missing/ASK/unsupported/mismatched declarations remain
unavailable; forming replacement and last-write-wins replacement withdraw
earlier evidence. Mixed bases do not become a homogeneous qualified window.

**The shipped MT5 feed does not declare its chart price basis.** No EA was
changed, declaration fabricated, broker contacted or actual broker research
acceptance established. Existing candles remain displayable while historical
cost research is intentionally held. Producer declaration is not independent
broker verification. Deriv compatibility semantics remain SYNTHETIC, not BID/MID.

## Exact combined checks

All11 serial commands exited0 on application7e597458afd4f3831d8fe75580334cfcc979c540.

| Check | Pass | Fail | Skip |
|---|---:|---:|---:|
| Full frontend (187 files pass,1 file skip) |2961|0|11|
| Research/Profit Mission contracts |158|0|0|
| Truth component/producer contracts |47|0|0|
| Candle/basis/source/normalizer/store contracts |124|0|0|
| Recorder/disclosure regressions |22|0|0|
| Guards |87|0|0|
| Binding assertions |7|0|0|

Targeted backend total329. Root/composite and all leaf typechecks pass. Dashboard build and isolated API build pass. These are exact combined-workspace results, not the upstream2963 frontend or composed321 backend claim. No failed command was rerun.

Immutable actual-Scanner ordinary production fixture:9816e45a0c91cdb8, clean exact application7e597458, sourceUnchanged:true, productionRuntimeChecked:true. It uses actual dashboard entry/Scanner, not a recreated component or production deployment.

The serial validation environment strips credentials, uses an offline
database placeholder and blocks external connections. API build output and
OpenAPI regeneration output are isolated under the validation directory.
Neither build starts the API or modifies its running bundle.

The installed Orval version remains 8.44.0 versus candidate generated headers
8.5.3. Isolated generation retains its React Query package-context warning;
unrelated regenerated hooks are not installed. No generator/dependency update
or forced schema push was performed. Existing large-chunk and test warnings
are retained in raw logs.

## Actual Scanner synthetic browser checks

**Browser acceptance is incomplete. No further attempts were made.**

| Attempt | Assertion pass/fail | Steps complete/failed | Unstarted | Skip |
|---|---:|---:|---:|---:|
| First combined Scanner run |23/0|6/3|0|0|
| Focused harness correction |3/0|1/1|5|0|
| Initial execution of previously unstarted cases |6/0|1/1|4|0|

Counts are per attempt, not cumulative unique coverage. All three assertions in
the second attempt were repeated setup. Five of the six in the final attempt
were repeated setup/dependency checks; the other was the transport audit.
Failed steps do not become passes because executed assertions were green.

First run,16.439s: actual240-bar qualified synthetic source, matching source
identity/finality and producer-declared BID evidence;14 explicit zero tick
counts and13 absent tick-volume observations. RSI matched native renderer and
inspector at the same timestamp; unsupported VWAP was refused;227 tick-volume
observations matched including explicit zeroes and gaps. Manual editable
EMA/ATR calculation completed in the existing disposable research Worker.
Selected trade text matched ledger entry/exit/cost evidence, bounded holding
segments were described, and the chart layer changed visibly. Closing cleared
the layer and left no active Worker. A language request populated the same
editable engine settings and completed a calculation. Mobile390px controls and
result were reachable without page horizontal overflow. This is not independent
pixel-coordinate proof for every native entry/exit/bracket anchor or whole-plot
viewport-fit acceptance.

Three first-run steps failed: the two-year request waiter reported an open-panel
reply without observing the workbench; basis withdrawal and missing-identity
waiters treated a Promise from the exposed reader as an array. Thus current
basis withdrawal, frozen-result/rerun, unsupported language and missing-identity
Truth acceptance were not established. First run retained152requests/responses,
no failed requests/external/WS,2Worker creations,62console errors and2page errors.
Only error counts—not messages—were saved in that first run, so they cannot be
attributed retrospectively. Its final explicit transport audit was not reached.

Focused correction,19.062s: async-reader predicates were corrected and messages
were captured incrementally. The assistant's latest message actually contained
the new Opened-Test-an-idea reply. The waiter nevertheless timed out because its
pre-send child count included a welcome card removed when messages arrived.
That is a harness synchronization failure, not demonstrated product breakage.
The requested-history refusal and unsupported multi-asset case remain unverified;
the prior reply/UI observation is not relabeled successful. Fail-fast left five
planned cases unstarted. Final audit hit a harness ReferenceError for
websocketBlocks. Raw responses retain91GET200,41GET503,4POST503; no failed or
external/WS requests,45console-error messages,0page errors,1Worker creation,
none active at cleanup.

Final unstarted-case attempt,19.465s: language flow was not retried. The final
transport variable was corrected and only the never-executed basis/Truth cases
were scheduled with their required manual setup. The desktop case stopped while
obtaining the *pre-withdrawal* explanation: the latest reply contained it, but
the same welcome-card indexing waiter timed out. **The actual basis-withdrawal
action was not reached.** Desktop missing-identity Truth, mobile withdrawal,
mobile Truth and mobile rerun-refusal were unstarted. No further retry followed.

The final transport audit did complete:69fixture transport records,44unknown
requests across21paths all503;4mutation attempts all503, no non503writes,
no external requests/WS. Browser events142requests/responses,0failed requests,
49console-error messages,0page errors,2Workers created, none active at cleanup.
All three owned fixture processes exited0 and browser contexts closed. The first
summary's SHA-256 remains98d64192d6f225825330d3f3bbba6e6c9f2d22468e85ff6e01c8c8db3083497c;
previous artifacts were not overwritten.

New browser runtime: native headless Chromium152.0.7977.64, Nodev24.22.1,
Linuxx64,8logical host CPUs; no CPU throttle configured, host contention not
quantified. Desktop1440x1100 and mobile390x844 were used in the first run. No
navigation benchmark, slowed-CPU acceptance or real-provider test was performed.

**Remaining blocker:** repair fresh-message synchronization before another
separately scoped browser attempt. The correction's basis withdrawal is covered
by automated capture/binding/component/producer regressions but NOT actual
Scanner desktop/mobile acceptance. Missing-identity transition, frozen-result
retention/rerun refusal and two-year/unsupported-language journeys remain open.
All raw failures and unfinished slots remain in the three separate directories.

Synthetic source-shaped fixtures are test inputs, not evidence from a real MT5
producer, broker execution or published environment. Browser calculation
Workers are bounded offline research computation, not operational API workers.

## Runtime preservation

API activation remains deferred. The existing process was PID425, started at
04:00:53 on 1 November 2026, with running bundle SHA-256:
`95f11b8d8fa6bd95e62d34b756ff964e86813f97355e4d989d23421b86e2a3da`.
Final preservation evidence confirms the same process start and identical bundle hash. New API-side basis handling is source-only; prior volume refreshed-process acceptance also remains unverified.

No API/service/operational-worker start or restart, service-setting change,
running-bundle replacement, database change/migration, publish/republish/deploy,
main merge, email, trading activation, funds movement, order or broker test.
Frontend/shared source can be newer than the running API; absent original
evidence from that API remains unavailable.

Only the development frontend workflow was refreshed, once. Vite reported ready in1942ms; that is server startup, not navigation performance. Anonymous /login rendered with expected401 identity response; this is not owner sign-in acceptance. The shared-router executable chartResearchEvidence module returnedHTTP200 with strict producer_declared matching and version2 snapshot guards. The running API was not refreshed.

Existing unrelated API polling/provider activity is not claimed to have stopped.
This update's offline fixtures do not authorize changes to other sessions.

## Retained failures and limits

The preceding import remains documented in `ARX_CHART_RESEARCH_DEVELOPMENT.md`
and `generated-artifacts/arx-research-validation/`, unchanged:

- Initial browser harness setup failure before Chromium launched.
- Corrected browser: 6 assertions pass, 2 fail, 5 failed/unfinished steps.
- RSI trailing-period parser failure; fixture-log lookup failure; assistant
  expected-text timeouts and dialog interception; no research Worker run;
  mobile and full research/Truth acceptance previously unverified.
- Secondary cleanup checks lacked `ss` and `/proc/net/tcp6`; these were not
  independent port-closure proof.

New results do not rewrite those old receipts. All new failures, skips,
unfinished attempts and screenshots are retained separately.

No new first-navigation, zoom or competitor timing benchmark was requested/run.
Original gates remain 150ms readiness-to-click and 100ms fully source-correct
visible completion. Prior 0 valid / 1 invalid / 9 unstarted, 1393ms readiness
and 239.3ms completion remain failures; valid median/max remain null. Earlier
0/4/16, forty invalid slots, sustained 180-second zoom timeouts, slowed-touch,
first-load/idle, partial-visibility and other recorded gaps remain open.

No real-user/provider/device, actual broker research, production-performance,
TradingView/MT5 parity, architecture-complete or launch-ready claim. General
strategy language, arbitrary long history, durable experiment saves,
account-currency/sizing, intrabar fill simulation and other prior gaps are not
completed by this correction.

## Evidence

Root: `generated-artifacts/arx-research-basis-validation/`.

- `upstream-compare.json`, `candidate/docs/CHART_PRICE_BASIS_EVIDENCE_2026_11_01.md`,
  `candidate/docs/CHART_RESEARCH_WORKBENCH_2026_11_01.md`.
- `scope-audit.json`, `preservation-audit.json`.
- `research-results.json`, `research-0.log` through `research-10.log`.
- `run.py`, `api-build-isolated.mjs`, `codegen.config.ts`, `codegen/`, `api-build/`.
- `fixture/`, `builds/`, `functional/` raw scripts, results and screenshots.
- `validation-summary.json`, `runtime-preservation-final.json`,
  `served-source-checks.json`, `evidence-sha256.json`, `final-checkpoint.json`.
- Browser first run:`functional/run-summary.json`; focused correction:
  `functional/remaining/run-summary.json`; never-executed cases continuation:
  `functional/unstarted/run-summary.json`. Corresponding JSONL logs, scripts,
  fixture logs, console/page-error details and screenshots remain alongside.

Generated/binary evidence is ignored by Git and deployment. The tracked final
report and exact application/checkpoint provide the recoverable source record.

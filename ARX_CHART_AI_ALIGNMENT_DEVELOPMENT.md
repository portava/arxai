# ARX chart/assistant/Truth alignment — development source validation

Date: 1 November 2026. Development source only; API activation remains deferred.

## Source and preservation

- Branch: `codex/pr103-smart-chart-development-20261031`.
- Final application: `5feede568fc47c1622300cd7a580f334ee628c69`.
- Initial combined import: `6dc07deee8197fe3f2179c7ef7ae85bfb8169d1c`.
- Recovery checkpoint: `f2d3e090f7112b307a1909230a0a73150888d2f7`.
- Recovery ref: `codex/backup-before-ai-alignment-20261101`.
- Pinned upstream report/checkpoint: `dc5f6d18a256f022847cfc723e7c7e3af274351e`.
- Upstream application: `532ce696811554776ad9c6efb08fb02a17ace3bf`.
- Upstream comparison base: `77359a70a61dcaf465fb19f917dbfed635ecd011`.
- Final saved workspace checkpoint is recorded in
  `generated-artifacts/arx-ai-alignment-validation/final-checkpoint.json`.

The initial branch/head/worktree matched the expected clean checkpoint.
No concurrent source edits were found while integrating; this is a point-in-time
observation, not an editing lock across sessions.

The reviewed manifest contains62 paths:55 source/contract/test/tooling paths and
seven documentation paths. The full comparison contains64 paths including the
final report/manifest. All64 pinned contents were archived and checked against
Git blob identifiers and, where listed, the manifest's SHA-256 hashes.

Initial import:55 application paths,53 matching the pinned target exactly.
The subsequently confirmed frozen-result bug required a two-file local fix
(one existing reviewed test file and its existing workbench component). Final
application changes span56 paths:52 of the55 imported paths remain target-exact;
package,v154andtheextendedtestarelocal reconciliations. The additional existing
component has only the validated invalidation-order correction, not speculative
feature work.
Two local reconciliations were required:

- API package: only the two changed offline test commands were applied.
  Existing local Express pin, test flags/omissions and dependencies remain.
- v154 EA source: only observed chart-price-basis declarations around CopyRates
  were added. Existing local duplicate-command, command-expiry and trade-result
  handling differences remain unchanged. The result exactly matches a clean
  three-way merge of the baseline, upstream base and reviewed target.

Authentication/sign-out, startup and Replit launchers, service settings,
dependencies/lockfiles, Truth and execution gates, funds behavior, prior chart
features and offline navigation recorder remain preserved. The reviewed
Fibonacci batch is now explicitly authorized; no other held performance branch
was imported. EA files are source changes only: none were installed or attached
to a terminal.

One initial parallel GitHub download was rate-limited429; a paced, resumable
download completed with all integrity checks passing. One bulk file-copy block
hit the tool's3MB budget; remaining files were copied in bounded blocks and
audited. A v154 patch context mismatch was corrected before the clean-three-way
audit. These were tooling attempts, not failed application tests.

## Changes to existing authorities

The current assistant uses the existing study collection/calculator to compare
moving averages and explain actual rendered values without inventing crossover
history, predictions or trading permission. Manual price sources/styles remain
authoritative; the full requested pair is checked before additions.

Fibonacci curiosity/preview/explanation routes through the current chart drawing
owner. A preview is not a saved drawing; Keep/edit is explicit, with existing
editing/undo/persistence and archived provenance. No separate chart, assistant,
study calculator, research simulator or trading engine was built.

Authenticated v2 ingestion retains its connection partition and producer price
declaration only after commit. Rollback/failed commit does not update the
analysis cache. Legacy DB integration fixture sources now use disposable
authenticated identities, but those integration paths were not executed against
any existing database during this update.

## Original clock authority

**No current production adapter qualifies original historical UTC.**
ISO formatting, a database column name or today's broker offset does not
establish historical UTC. MT5 MqlRates coordinates can be broker-clock values.
Nothing here reconstructs or rewrites those stored times.

The backend resolver registers no qualified production authority and refuses
arbitrary self-declared UTC payloads. Frontend version3 research snapshots
require consistent original clock authority as well as original price basis.
Chart/reader/replay/Fibonacci labels preserve source-clock limitations, and
unqualified timezone preferences do not shift candle coordinates. Prices remain
visible. Historical research and timezone conversion are intentionally held
when authority is absent.

Generated `offline:utc-clock-fixture-v1` normalized evidence is only a consumer
test fixture. It is not a production authority registration, MT5 certification,
historical timezone reconstruction or real-provider acceptance. EA chart-mode
declarations address BID/LAST price provenance, not historical clock authority.
Other existing source-clock-derived diagnostics and stored history are not
claimed repaired by this interim gate.

## Exact combined automated validation

All13 serial commands exited0 on combined application6dc07deee8197fe3f2179c7ef7ae85bfb8169d1c. No failed command was rerun.

| Check | Pass | Fail | Skip |
|---|---:|---:|---:|
| Full frontend (193 files pass,1 file skip) |3060|0|11|
| Research/Profit Mission contracts |158|0|0|
| Truth component/producer contracts |47|0|0|
| Candle/price/clock/source/normalizer/store |141|0|0|
| Authenticated v2 feed/liveness mock contracts |34|0|0|
| Extracted producer C++ payload checks |60|0|0|
| Recorder/disclosure regressions |22|0|0|
| Guards |87|0|not reported separately|
| Binding assertions |7|0|not reported separately|

Backend total380; these are not the upstream372 results. Frontend3060 is not the upstream3062 claim. Different preserved baselines are not byte/test parity.
All composite and four leaf typechecks pass, dashboard build passes, isolated
API build passes. C++ harness checks:v15111,v15220,v15420,kernel9; no native
MQL compiler/terminal acceptance or EA installation. The two imported real-DB
integration fixture paths were deliberately not executed; upstream disposable
PostgreSQL53checks are not attributed to this workspace. No existing DB was used.

Immutable ordinary production-mode actual-Scanner fixture:c472b4a550d4530f,
source6dc07dee clean, sourceUnchanged:true, productionRuntimeChecked:true.
This is an offline actual dashboard entry/Scanner fixture, not deployment.

The serial lane strips credentials, blocks network connections and uses an
offline database placeholder. Any mock simulator/calculation workers belong to
disposable test processes, not operational services. No API app server is
started. API build and Orval regeneration output are isolated from running
bundles/source-generated hooks.

Installed Orval remains8.44.0 versus candidate headers8.5.3. The isolated
generation's React Query package-context warning and formatting differences are
retained. Unrelated generated hooks were not replaced and no dependencies or
lockfiles were changed. Build/chunk/test warnings remain in raw logs.

## Actual Scanner synthetic browser validation

**Browser acceptance is partial; no final all-green or mobile acceptance claim.**

The same named tester performed one desktop journey and one bounded focused
continuation for never-executed commands and the inconclusive rerun gate. The
initial14-group checklist was8pass,1not-demonstrated,2skipped,3unstarted. The
expanded terminal checklist was21groups:13pass,1confirmed product defect,
2skipped,5unstarted. These are operator-grouped checks, NOT152automated
assertions or35distinct passes; the expanded checklist repeats baseline groups.
All pre-fix browser evidence is for6dc07dee / immutablec472b4a550d4530f.

Observed passes include:

- Actual Scanner reached as synthetic USER/PAPER; no owner/admin identity used.
- Corrected200-bar V75/M15 fixture matched canonical original OHLC initially.
- One unqualified source-clock warning; stored New York preference ignored,
  timezone control disabled, source-clock labels not converted to claimed UTC.
- Manual EMA13/High remained through evidence refresh and local20/50comparison.
- Direct Test-an-idea ran the EXISTING engine with a generated172-bar qualified
  BID/UTC sample,0observed gaps,3chronological partitions and0completed trades.
  An unresolved development outcome is not a winning-strategy result.
- Clock evidence withdrawal refreshed the200original-bar fixture, returned
  the source-clock warning/disabled timezone and left the frozen result
  inspectable with a current-marker-withholding warning BEFORE rerun.
- The authorized rerun click produced the explicit missing-original-UTC refusal
  before runner.run. An enabled button alone had been inconclusive, not proof
  that the calculation gate failed.
- Actual local Compare-the20EMA-and50EMA added one Close-source pair, preserved
  EMA13/High, and repeated comparison left exactly3studies. The receipt reported
  EMA20=2298.1428 andEMA50=2298.7846 at2026-11-01 06:45 source clock/unverified.
  The tester did NOT independently cross-check those numbers in Data Window.
- Unsupported GBPUSD comparison refused locally with Chart-not-changed and
  retained all studies/preferences.
- Preview-automatic-Fibonacci produced a source-backed two-anchor/levels
  proposal and exposed Keep-and-edit/Dismiss. Objects remained0 and drawing
  storage null: the proposal was not silently committed.

The pre-fix product failure was real: after an evidence-refused rerun the
already-frozen result disappeared. Source inspection found invalidate() before
eligibility checks. This was corrected locally, not copied from an unreviewed
branch: validate draft/capture/finalization BEFORE invalidating the previous
result. Existing rule-edit invalidation and successful-run generation/cancel
behavior remain unchanged. An extended component regression failed before
correction (6pass/1fail, red-0.log) at the missing frozen-result assertion.
On final application5feede568fc47c1622300cd7a580f334ee628c69, the FULL frontend
suite passes3060/0fail/11skip, including all7workbench cases with the extended
refused-rerun/frozen-result assertions. Dashboard typecheck/build and87guards/
7bindings pass again. Logs:final-0.log through final-3.log. Backend/domain/
generatedcontracts/EA/scripts/dependencies are byte-identical to6dc07dee, so their
380backend,60C++payload,22recorder,root/otherleaf types and isolatedAPIbuild
receipts remain valid without rerunning unchanged checks. This is not a claim
those commands were re-executed at5feede56. The final immutable Scanner fixture
2eecf55e5a25aeea was built from clean5feede56 with sourceUnchanged:true; it was
not browser-exercised. The earlier browser fixture remainsc472b4a550d4530f.
This is not a claim that the browser failure was replayed successfully.

Still skipped/unverified: no completed trade existed, so selected native trade
markers, trade-detail removal and basis-only withdrawal were not exercised.
EURUSD selection was skipped because the approved-universe GET was intentionally
unavailable503; no symbol/permission was injected. No completed-trade safety
transition can be inferred from an empty ledger.

Five unstarted groups remain: visual Fibonacci canvas geometry; Explain-preview
command; Keep/edit/persistence/undo/redo; manual-versus-language anchor parity;
phone390x844. A proposal/control screenshot does not prove native geometry or
mobile usability. No slowed-CPU/performance round was run.

The final ledger retained8363events,2132requests,60fixture reads (45unqualified,
15qualified), and46app-originated POST attempts, ALL intercepted503:29automatic
ai-alerts/scan,13activity-ping,2scalp-focus,2assistant/conversations. Conversation
creation is not a model submission. No model/chat-message-send POST path,
broker/order request or external socket was observed. These automatic attempts
are disclosed, not called zero API traffic. Earlier ledger totals included
1046requests/1045responses (186x200/859x503),839unknown GETs blocked503,
2request failures and1page error; counters are successive snapshots, not summed.

Harness failures retained: ERR_CONNECTION_REFUSED after tester-launched static
fixture lifetime ended, localStorage SecurityError on that error document,
aborted account-stream GET, fixture lifecycle failure and contract correction.
The first payload lacked required aiUsable:boolean; correcting the synthetic
contract to aiUsable:false enabled its200bars. That is a fixture correction,
not a product success on malformed data. No source gate was loosened.

The continuation used a main-owned sanitized background static server; browser
context/research Worker lifecycle closed and main stopped that server afterward.
This round used tester browser automation at desktop1440x1100. Exact browser
engine/version, launch mode and CPU-throttle/runtime metadata were not retained
for this round; earlier Chromium152/Node24 receipts belong to the prior basis
round and must not be attributed here. No4x or phone case was completed, and host
contention was not measured. These are not physical-device or latency receipts.

Durable functional/run-events.jsonl and verbatim first-terminal-report.json /
focused-terminal-report.json preserve the claims/limitations. Two truncated
action outputs were copied from temporary storage into functional/raw-actions/.
Browser screenshots were returned as evidence IDs, not localPNG files:
btd7lw,rd0tt5,zn55m5,d79mxc,6tu6ta,j7i87x,80sp7b,9jm1g3. They are not claimed
as workspace PNG artifacts. Anonymous login smoke is separately saved on disk.

## Development runtime and safety boundaries

Initial API identity: PID425, started1November2026 04:00:53; bundle SHA-256
`95f11b8d8fa6bd95e62d34b756ff964e86813f97355e4d989d23421b86e2a3da`.

Final verification found the same PID425 start time and identical running bundle
hash. No API/service settings changed. Only the frontend workflow was refreshed
(after the import and after the confirmed UI correction); final Vite startup
reported685ms, not a Scanner navigation measurement. Anonymous /login smoke
rendered, with expected401 identity response; no owner sign-in acceptance.
The shared router serves the new clock/version3research modules and the fixed
workbench handler with capture/finalization checks before invalidation.
The main-owned static fixture was stopped after the bounded continuation.
Optional clock-adapter qualification and disposable authenticated-feed rehearsal
were proposed separately; neither was executed or activated.

New API/domain source is not a refreshed API process. Missing evidence from
that older running bundle stays unavailable. Previous volume/basis
refreshed-process acceptance remains unverified.

No main merge, publication/deployment, API restart/activation, running API bundle
replacement, service-setting change, existing-database changes/migrations,
EA installation, operational-worker/trading activation, emails, funds movement,
orders, external model request or live/demo broker test was authorized/performed.
Offline browser research Workers are bounded synthetic calculation, not
operational worker activation. Existing unrelated API activity is not claimed
stopped or reconfigured.

## Retained failures and limits

The previous reports remain unchanged:

- `ARX_CHART_RESEARCH_BASIS_DEVELOPMENT.md`
- `ARX_CHART_RESEARCH_DEVELOPMENT.md`
- `generated-artifacts/arx-research-basis-validation/`
- `generated-artifacts/arx-research-validation/`

Prior price-basis browser attempts remain23/0 assertions with3failed steps;
3/0 repeated setup with1failed step/5unstarted;6/0 mostly repeated setup with
1failed step/4unstarted. Exposed-reader Promise and unstable welcome-card
message-index failures prevented the actual basis withdrawal/missing-identity
actions. Earlier6pass/2fail assertions, initial harness bootstrap failure,
unfinished research/Truth/mobile cases and missing first-run error messages
remain retained. New evidence cannot retroactively relabel those failures.

No new first-navigation benchmark is claimed. Original150ms readiness-to-click
and100ms full source-correct visible completion gates remain unchanged.
Prior0valid/1invalid/9unstarted with1393ms readiness and239.3ms completion;
earlier0/4/16, forty invalid slots, sustained180-second zoom timeouts,
slowed-touch/idle/first-load failures and partial-visibility gaps remain open.
Valid timing median/max remain null where no valid samples existed.

No actual UTC producer/provider, owner sign-in, physical mobile device or
published-app acceptance; no architecture-complete, launch-ready, latency-fixed
or TradingView/MT5 parity claim. Real-volume VWAP/profile, arbitrary strategy
language/deep history, durable research saves, sizing/account-currency and
other prior limitations are not completed by this source batch.

## Evidence paths

Root: `generated-artifacts/arx-ai-alignment-validation/`.

- `candidate/docs/SMART_CHART_AI_ALIGNMENT_2026_11_01.md`
- `candidate/docs/development-sync/SMART_CHART_AI_ALIGNMENT_2026_11_01.json`
- `candidate/docs/ORIGINAL_CANDLE_CLOCK_EVIDENCE_2026_11_01.md`
- `upstream-compare.json`, `download-audit.json`, `base-tree.json`,
  `base-audit.json`, `scope-audit.json`, `preservation-audit.json`
- `research-results.json`, `research-0.log` through `research-12.log`
- `red-results.json`, `red-0.log`; `final-results.json`, `final-0.log` through
  `final-3.log`; `fixture-results.json`, `fixture-0.log`, `postfix-run.py`
- `postfix-preservation.json`, `frontend-status-final.json`,
  `served-frozen-result-fix.json`
- `codegen/`, `api-build/`, `fixture/`, `builds/`, `functional/`
- `validation-summary.json`, `runtime-preservation-final.json`,
  `served-source-checks.json`, `evidence-sha256.json`, `final-checkpoint.json`

Large/generated evidence remains in the ignored workspace directory, not Git
or deployment. The final tracked report and source/checkpoint preserve the
recoverable development record.

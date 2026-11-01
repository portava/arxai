# ARX selected-pane / Volume Profile — development source-only report

## Outcome

Reviewed source integrated selectively. Offline application tests, typechecks,
isolated builds, guards and binding assertions passed. **Actual Scanner browser
acceptance remains blocked; this is not release-green or a performance result.**

No API or application workflow was started/restarted, no running bundle replaced,
no existing database used or changed, and no publishing/main merge occurred.
No operational worker, settlement, trading, email, funds or broker action was
activated. Test children used synthetic credentials only and blocked TCP.

## Exact source and recovery

- Branch: `codex/pr103-smart-chart-development-20261031`.
- Recovery checkpoint retained:
  `fb307edb33aedcb35b8ed1dd97ab750116251f12`.
- Recovery branch: `codex/backup-before-volume-profile-20261101`.
- Prior application: `1b352c2e24d8282cc910cf8705326fc6cc220b33`.
- Reviewed upstream saved head:
  `f419a37b235ad7f7b9d83ac6e7d96fad674251f1`.
- Upstream application:
  `f6e64fbea949e3ce21a99696dfab0b3c975f6caa`.
- Upstream QA source:
  `a02e76bbf9314e1f69d964c93f9801c5ca1e6c1b`.
- Initial combined import: `2bca0401b238f7a3bf63851f89353a8d55ab00f2`.
- **Application tested by the full validation lane:**
  `7bd175eaeb0344b9ee91fe8a86e06c11e1535971`.
- Later **QA-only** correction:
  `ecbfde354f28c06624bdcd3628dc2a247cccbd4e`.
  Both its `arxai/artifacts` and `arxai/lib` Git trees are identical to the tested
  application. Browser fixtures and corrected QA checks used this QA source.
- The final workspace checkpoint is the documentation commit containing this
  report; its exact hash is saved in
  `generated-artifacts/arx-volume-profile-validation/final-checkpoint.json`.
  It is intentionally not embedded into its own committed contents.

All three pinned upstream revisions were verified through GitHub. Their
artifacts/lib trees match. All 56 inventory SHA256 values were verified before
application; the comparison base was
`41934a4c24fa54a6fa0e34cdd62adfbc7e792bf7`.

## Scope and reconciliation

The same chart/study/assistant/Truth owners now contain selected-pane assistant
ownership, analysis-only stock comparisons, estimated fixed-range Volume
Profile, exact source-bound quantity/VWAP labels and the reviewed advisory
correction. No second chart/calculator/assistant system was added.

Profile eligibility still requires original qualified Common Stock trade units,
original UTC and closed bars. Tick substitution, inferred price basis,
order-flow claims and trade permission remain prohibited. A session-gap advisory
alone is not corruption; the remaining evidence/finality/context gates remain.

**52/56 inventory files match upstream exactly. Four reconciliations:**

1. Dashboard package: retained local dependencies, fields, scripts and lifecycle
   command; unioned 14 new test registrations rather than replacing the script.
2. Chart witness: additive volume-profile/research observers, preserving local
   observations.
3. Fixture builder: retained normal build/serve and durable navigation recorder;
   added only the explicit volume-profile mode, its pinned mode-specific runtime
   checks/metadata and port. Ordinary fixture still requires React plus the
   native chart runtime; isolated adapter mode requires the native runtime.
4. Fixture entry: normal actual dashboard or explicit isolated profile probe.
   Removed incoming held profiling/feed experiment branches and imports.

Three additional **pinned prerequisite QA files** close the fixture source:
`stylesheet.mjs`, `routes.mjs`, `index.html`, all under
`arxai/scripts/scanner-qa/shared-chart-fixture/`.
Their Git blobs and SHA256 values are retained in `qa-dependency-audit.json`.
The local fixture entry had previously been absent despite upstream marking it
modified; that difference was reconciled, not treated as a concurrent deletion.

Authentication/sign-out, startup, dependency/lockfile choices, Truth/safety,
funds/cockpit and local test commands were retained. Primary Focus and trading
universe were not expanded. Held performance experiments were excluded. Only
offline fixture tooling imports the diagnostic probe; normal app runtime does
not import it. No tracked concurrent edits were observed before integration or
before final documentation; this is a worktree observation, not a claim about
all agents elsewhere.

## Exact application validation

All commands ran in a byte-verified scratch source copy, not existing output
directories. The final comparison verified **7,488 copied source files** without
unexpected modifications. External dependencies were reused; no installation or
lockfile change was needed. No code generation or migration was run.

| Check | Actual pass | Fail | Skip |
| --- | ---: | ---: | ---: |
| Full frontend Vitest | 3,294 | 0 | 11 |
| Backend backtest/research/profit mission | 158 | 0 | 0 |
| Truth component evidence | 47 | 0 | 0 |
| Chart candle shape/provenance | 155 | 0 | 0 |
| Quote observation freshness | 57 | 0 | 0 |
| Chart Truth fixtures | 52 | 0 | 0 |
| Forming-tip source gate | 18 | 0 | 0 |
| Bridge liveness | 34 | 0 | 0 |
| **Targeted backend total** | **521** | **0** | **0** |
| Navigation recorder + disclosure | 22 | 0 | 0 |
| Guards, corrected command | 87 | 0 | 0 |
| Binding assertions, corrected command | 7 | 0 | 0 |

Frontend: 207 test files passed, one file skipped. These are the workspace's
counts, **not** upstream's 3,296/513 figures. No equivalence of test inventories
is asserted solely from counts.

Root composite library typecheck and all four leaf typecheck commands passed.
API and frontend production builds passed in scratch. Both normal actual-app
and isolated adapter fixtures built successfully at the QA-only source.
Builds retained sourcemap/module-directive/chunk-size warnings; passing does not
mean warning-free. Full-suite application results remain valid because the
later QA correction changed neither artifacts nor lib trees; they were not
needlessly rerun or attributed to altered application bytes.

### Retained failed attempts

- First `combined` lane: **14 failed commands, one passing command**. Twelve
  were blocked by self-referential scratch `.bin` links (including a partially
  completed typecheck); two fixture builds lacked the pinned HTML prerequisite.
  The passing command had 22 recorder/disclosure tests.
- Next `final` lane: **13 passing commands, two failed commands**.
  Guards printed 87/87 and seven bindings but exited 1 on loader Unix IPC;
  isolated profile build incorrectly required React. Neither failed exit was
  relabeled a passing command.
- `qa-correction` lane: **4/4 commands passed**, after preserving Unix compiler
  IPC without allowing TCP and applying the pinned mode-specific runtime check.
- Stock fixture producer: **0 pass / 1 failed assertion / 4 unstarted**.
  An independent synthetic original-provider attempt returned 0 instead of 300
  normalized candles. Cause unresolved; no qualified stock payload or actual-page
  positive acceptance was inferred. Its assertions ran before response files
  were persisted, so there is no recoverable normalized payload for this attempt.
  It was not retried or bypassed.
- Proposal preparation first stopped on the absent local modified fixture entry;
  an initial file-transfer block hit its byte budget after 52 files. Remaining
  paths were completed and verified byte-for-byte. These are retained
  preparation errors, not application test results.
- Final status allowlist initially failed because Git collapsed the two new
  JSON guides into an untracked directory. Explicit untracked-file enumeration
  showed only the seven expected report/memory/guide paths; no concurrent
  application edit was found. See `finalization-audit.json`.

## Browser evidence — separate scopes

### Actual Scanner fixture

Owned loopback **static** build `e78f25a3162a51cf`; no API server. Before
navigation, every API request was intercepted, mutations/external/WS blocked.
No real authentication, owner preferences or operational actions were used.

1. Original attempt: **1 safety pass / 1 metadata failure / 3 unstarted**,
   stock journey explicitly skipped. Main supplied the wrong metadata URL; it
   returned 404. With `/api/me` synthetically unavailable, page showed login.
   One synthetic API GET, no mutations/external/WS.
2. Narrow correction: **2 harness passes / 1 routing failure / 1 skip /
   3 unstarted**. Correct `/arx-scanner-qa-build-info.json` independently verified
   source, build, clean status and empty diff hash. Explicit synthetic USER
   identity reached Cockpit, but observed `/market-scanner` link and direct
   navigation both returned to Cockpit. **Route/permission reason unresolved.**
   Of 154 API attempts, three synthetic identity GETs and 150 unavailable GETs
   were intercepted; one background `POST /api/me/activity-ping` was blocked.
   Zero candle GETs, external HTTP or WS attempts.

No actual Scanner candles/RSI, native conversation toggle/focus or conditional
phone case executed. No further route/permission repair was attempted.
The earlier native composer-focus failure and unfinished desktop/volume/research
journeys remain open. Actual-page upstream 390 assertions were **not rerun**:
their journey/fixture package is not portable in the reviewed GitHub source.

Browser: Chromium 140.0.7339.16, Linux x86_64, desktop 1440x1100, DPR 1,
no touch points, webdriver true. Headless status not exposed. Phone unstarted.

### Isolated native-adapter probe

Owned static build `0ae5a973bbb368cd`, not the actual app or Scanner.
**7 untimed functional passes / 0 functional failures / 1 benchmark skip /
0 functional unstarted.**

Verified metadata and exposed native probe; constructed 5,000 closed synthetic
bars reported 5,485,425 trade units. The probe reported 2,004 price bars
overlapping logical viewport range 2996–5007; this is not a physical-paint count
or aggregate participation.
Changing 32 to 128 rows preserved all 5,000 bars and the total. At 128 rows,
POC index 83 and 83 geometry segments were reported. Hiding profile removed
geometry, retained all candles/ready aggregate; re-show rendered the overlay.
Four static requests, **zero API/mutation/external/WS/failed requests**.
This is constructed adapter evidence, not original-provider or UI eligibility
acceptance. Aggregate quantity was observed; this does not constitute an
independent replay of all upstream total/PNG/assistant assertions.

**Benchmark attempt failed to return:** checked-in unmodified
`measureVolumeProfile` invoked once with default 30 samples/5 warmups.
SDK execution reset after **45 seconds**, before module return. No trustworthy
partial samples, outliers, workload completion counts or CDP cleanup telemetry
survived. Eight workloads were planned; their individual completion states are
unknown, not zero-duration passes or eight known-unstarted workloads.
1x/4x were planned; actual applied rates are unverified. No performance
pass/fail, p95, speedup, physical paint or navigation result exists.
The requested five-minute phase budget did not override the SDK's 45-second
individual execution deadline. No retry or improvised timing loop followed.

Fallback: Chromium 140.0.7339.16, Linux, 1440x1000, DPR1; no CDP throttle was
requested in the fallback, but inherited effective rate after timeout was not
independently proven. Hardware/host contention unmeasured; serial owned window
had no other validation or browser jobs requested by this agent.

Main screenshot-service attempt returned HTTP500 for the loopback probe;
this is a screenshot-tool failure, not established application HTTP500.
Tester images `tlgthv` and `0dyi07` show profile visible/hidden; image references
are in JSON rather than standalone workspace PNGs. Both owned static servers
and test contexts were stopped/closed at terminal completion; interrupted
benchmark cleanup telemetry remains unknown.

## Runtime preservation and remaining limits

Final `runtime-preservation-final.json` compared complete directories:

- Existing API PID **425**, same start **Sun Nov 1 04:00:53 2026**.
- **All 11 API dist files unchanged**, including compiler metadata.
- **All 305 frontend dist files unchanged**.
- No changed, missing or added runtime output paths. No metadata exception
  this round. Exact per-file hashes are in baseline/proof evidence.

The running API was not activated to this source. Missing optional evidence
from the older API remains unavailable; source changes or synthetic tests are
not runtime/provider acceptance. Frontend source watching may consume source
changes, but its production dist was not replaced.

No actual API health request, existing DB, broker, provider, model, email,
trading or order test was used. Existing job/service settings were preserved,
not changed and then restored.

Still open: positive actual-page stock/VWAP/profile and export acceptance;
selected-pane desktop/mobile journeys; previous focus/visibility failures;
original provider/runtime research acceptance; real first-navigation latency;
broader research and competitor parity. Prior performance failures remain:
0 valid / 1 invalid / 9 unstarted (1393ms readiness, 239.3ms source-correct
completion), earlier 0/4/16 and forty invalid slots, sustained zoom deadlines
and slowed-touch/partial-visibility gaps. No new navigation sample resolves them.

## Evidence paths

Root: `generated-artifacts/arx-volume-profile-validation/`.
Generated receipts are intentionally ignored by Git but retained in workspace.

- `baseline.json`, `upstream-verification.json`, `download-audit.json`
- `merge-audit.json`, `integration-audit.json`, `qa-dependency-audit.json`
- `final-source-audit.json`, `local-application-tree-equality.json`
- `scratch-source-manifest.json`, `validation-counts.json`
- `combined-results.json` + `combined-0.log` through `combined-14.log`
- `final-results.json` + `final-0.log` through `final-14.log`
- `qa-correction-results.json` + `qa-correction-0.log` through `-3.log`
- `fixtures-results.json`, `fixtures-0.log`, `produce-stock-fixture.mjs`
- `browser-actual-scanner-results.json`, `browser-actual-scanner-events.jsonl`
- `browser-actual-scanner-correction-results.json` and `-events.jsonl`
- `browser-isolated-probe-functional.json`, `browser-isolated-probe-events.jsonl`
- `browser-isolated-probe-benchmark-timeout.json`
- `runtime-preservation-final.json`, `evidence-sha256.json`,
  `finalization-audit.json`, `screenshot-service-failure.json`,
  `final-checkpoint.json`

Pinned upstream guides/manifests are preserved under their original
`arxai/docs/` paths. Their upstream test counts describe upstream, not this
workspace. This report is the local acceptance record.

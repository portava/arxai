# Chart Truth Crosscheck — development source backup only

## Outcome: source backed up, frontend-isolation boundary not established, NOT release-green

The reviewed cumulative source was selectively integrated and independently checked in an offline copy. **The requested no-visible-frontend-change boundary cannot be claimed:** late process inspection found the dashboard already running Vite dev against the edited source directory. No explicit restart/activation action was taken, but mutable source can become visible without one. This should have been checked before applying the import. Further application edits stopped; no automatic rollback was attempted.

The original API and dist outputs are preserved. Application tests, typechecks and builds pass; the complete repository-root static run is **84/87**, with three unresolved wording guards. Previous Replit historical/Fibonacci browser acceptance remains incomplete.

## Exact source and recovery

- Branch: `codex/pr103-smart-chart-development-20261031`.
- Recovery/current-before-import: `debf81f33c6b4984032ad3216a95428ef02d40cd`.
- Recovery branch: `codex/backup-before-chart-truth-crosscheck-20261101`.
- Earlier application/checkpoint remain preserved: `e4bbba1e2bdccda166566892d0e7600a4bea8cf4` / `08ea8e7158765182977075236a93966a773b7abc`.
- Reviewed GitHub branch: `portava/arxai` / `codex/chart-compact-study-labels-20261101`.
- Exact pinned head: `78f7721f102cf382795417528fd6094b734e9abb`.
- Manifest application/tooling commit: `8bbf5e3d54231d485cf7ca5cefc5357d70105a8a`.
- Upstream validated application: `47cbb89a77f4d3dc1d9d63c7893969b23eb9aa7c`.
- **Combined application/QA commit validated here: `31f4a51fea267c737cb57a4c50f2c1eb818e6711`.**
- Offline actual-App build, built but not served: `c10219a2e17688b2`.
- Final documentation/workspace checkpoint is recorded in the completion response and `generated-artifacts/arx-truth-crosscheck-validation/final-checkpoint.json`. Application/library/script trees must remain identical to the validated commit.

## Review and reconciliation

Read the pinned Truth Crosscheck report, source manifest, validation receipt and preceding support/resistance and study-explanation reports. All 28 source/QA SHA-256 values were verified. The full comparison from `0e95a1623a7c3b1236cdf7531efe3696cd8fd045` contains exactly those 28 non-document files; no additional code was imported. Saved head and `8bbf5e3d` have equal artifacts/lib/scripts trees; their artifacts/lib trees also equal application `47cbb89a`.

Twenty-five manifest files are target-exact. Three preserve local differences:

1. Dashboard package: retain every local script/dependency/field; append only the three new chart test registrations.
2. Scripts package: retain local-only auth and other test commands; incorporate the reviewed selected-market negative-test registration.
3. Chart witness: retain local shallow configuration capture and omitted linked-view/calculator/series identity instrumentation; add the reviewed title-aware line-options inspection. No held performance instrumentation was restored wholesale.

All production TypeScript in the manifest is target-exact. Existing auth, sign-out, startup, dependency/lockfile, chart/research/frozen-result, Truth, funds, trading safety and QA-builder corrections outside the manifest were untouched. Initial and pre-apply Git states were clean at the expected recovery. No concurrent tracked edits were observed or overwritten; that is not a claim that no external agent exists.

The now-reviewed support/resistance work is authorized by this new manifest; the earlier unfinished branch was not separately imported. The existing confirmed-pivot/source-window owner supplies bounded candidates, preview/Keep/selection controls and honest limitations, not a second chart or trading authority. Existing study calculators/validators handle bounded MACD/Bollinger edits and named-channel explanations. Narrow charts hide floating study titles below 600 actual chart pixels while retaining numeric axes and named inspection values.

Selected-market source now uses the existing connected-calendar resolver, carries availability/applicability through response/cache/display, withholds unavailable analysis grades and retains independent valid calendar/price evidence. The complete original event set reaches the shared risk scorer even when only future events are displayed. Legacy evidence remains unverified; neither a failed calendar nor an empty future list certifies no risk. No database schema, risk scorer threshold or order gate was changed.

## Independent checks on the combined source

| Check | Pass | Fail | Skip |
|---|---:|---:|---:|
| Full frontend | 3,401 | 0 | 11 |
| Existing targeted backend suites | 521 | 0 | 0 |
| New selected-market backend, corrected lifecycle run | 18 | 0 | 0 |
| Recorder/disclosure tooling | 22 | 0 | 0 |
| Portable stock-fixture tooling | 9 | 0 | 0 |
| Root-directory static guards | 84 | **3** | 0 |
| Binding assertions, corrected command | 7 | 0 | 0 |

The 539 targeted backend passes are unique suite results, not a count that includes the repeated non-exiting attempt. Selected-market guard negatives reject **14 mutations**, with valid-source, existing-invariant and harmless-comment checks also passing.

Frontend files: 211 passed, one skipped. Library project builds and all four artifact/script typecheck units passed. Isolated API build, ordinary frontend build and the separate offline actual-App fixture build passed. Upstream 3,403 frontend/19 browser assertions and earlier 40/41 or 31/31 browser receipts remain source-specific; they are not this workspace's results.

Validation used a verified 7,517-file tracked source copy with 224 redirected dependency links. Existing packages were reused read-only; no install or lockfile replacement occurred. Child environments contained dummy-only credentials/database URLs and disabled execution/settlement/public-feed flags. A TCP-denying guard permitted compiler Unix IPC. No existing database or actual API server was used.

### Root guard result is authoritative

Exact cwd: `generated-artifacts/arx-truth-crosscheck-validation/scratch/arxai`, the application repository root with scan directories present.

- `risky-wording-frontend`: **50 findings**.
- `no-internal-names-user-ui`: **25 findings**.
- `investor-no-guaranteed-return`: **3 findings**.
- Complete runner: **84/87**, exit **1**.

The three guard implementations are byte-identical to the recovery checkpoint; see `wording-guard-source-proof.json`. The upstream baseline proof belongs to its recorded commits, not a newly rerun baseline here. Some reported matches are tests/comments; 78 findings are not 78 demonstrated product defects.

The usual package/scripts cwd can silently miss paths. It was not used as a replacement or a green diagnostic. Earlier recorded 87/87 package-cwd output does not establish complete repository-root scan coverage. No guard implementation, wording assertion, scan root or threshold was changed to bypass these failures. This is not full root CI or release acceptance.

## Retained preparation and validation failures

- An automatic witness three-way merge refused the local instrumentation overlap before any application write. It was reconciled as described above, preserving the local omissions.
- A generated package-merge helper initially misclassified a local-only auth test script as an upstream deletion. Source was still untouched; missing-key handling was corrected and the local script retained.
- A Git recovery-branch operation was initially blocked by the platform Git safeguard. It was retried with the required explicit command flag; no reset, branch replacement or lock deletion was used.
- The initial 18-command sequence returned nonzero for the real root guard failure, the non-exiting selected-market child and an incorrect generated binding filename. These original records remain intact: **15 successful commands / 3 nonzero commands**. Two later scoped corrected commands exited 0; the root guard result remains failed.
- Selected-market initially printed 18 passes but did not produce a terminal summary. Only its owned validation process group was terminated. The corrected bounded run used Node's `--test-force-exit` with the identical source/assertions and produced 18 pass / 0 fail / 0 skip plus exit 0. The log reports `marketSimulator started` inside this isolated test import; it is not evidence of original-API or operational-worker activation, nor proof that this was the sole open handle. The owned process exited; all TCP remained blocked.
- Initial binding command referenced a nonexistent generated filename and failed `ERR_MODULE_NOT_FOUND`. The actual filename was read from the preserved package script; its targeted corrected invocation passed all seven assertions. No source assertion was relaxed.
- A premature read-only preservation inspection explicitly declined a final claim while validation was still active. Final preservation evidence was recorded only after the main sequence completed.

## Browser/runtime limits

**No new browser or navigation measurement ran in this round.** The fixture was built only; no validation HTTP server was started. No actual private sign-in, real calendar/provider, physical-device or published-app acceptance is claimed. Source features may be exposed by the existing dev server; actual client refresh/HMR visibility was not inspected and is not asserted either way.

Keep the earlier historical witness timeout, corrected trade-row locator timeout and Fibonacci `50%` versus `50.0%` assertion failure. Selected-ledger replies/settings/withdrawal, preview Keep/manual ownership and the two distinct mobile feature journeys remain incomplete. Their blocked conversation POST and unfinished strict background-allowlist acceptance remain open.

Prior first-navigation invalid/unstarted samples, composer focus loss, partial visibility, slowed-touch failures and sustained zoom deadlines remain unresolved; no retiming was performed. Unconfirmed/failed-reader-to-stale mapping needs separate reproduction. General automatic drawing/pattern coverage, simplify/restore, historical capital/sizing/equity/benchmark and platform/provider parity remain incomplete. Current provider clock authority was not newly qualified or invented.

## Preservation evidence and important frontend exception

`runtime-preservation.json` verifies original API PID **425**, start **Sun Nov 1 04:00:53 2026**, unchanged. All **16 baselined original dist trees / 6,447 files** have equal file sets/hashes, including API/frontend outputs. All **16 baselined compiler metadata files** are unchanged. No metadata was restored to disguise a side effect.

**Those hashes are not proof of frontend preservation.** Read-only process inspection found dashboard PID **18747**, started **Sun Nov 1 07:30:25 2026**, running Vite dev with `--config vite.config.ts` from `arxai/artifacts/trading-dashboard`. Its configuration resolves the root and source alias to that mutable directory and does not disable default watching/HMR. PID 195 is the separate mockup sandbox and is not the dashboard. Current startup-script text alone did not establish the actual running service mode.

Therefore frontend source edits were eligible to be served/HMR-updated, despite unchanged dist and no explicit restart. Vite's transformed in-memory modules and dependency cache were not baselined; the dist comparison cannot cover them. No actual frontend request or browser session was used to test visibility; indirect client requests/effects following source updates were not traced. **Overall requested runtime/frontend isolation is not verified and must not be reported as met.** Future source-backup-only imports need an unwatched checkout/worktree instead of edits to this served tree.

No original API/frontend restart, explicit refresh/activation, service-setting change or dist replacement was performed. No database migration, operational worker/settlement/trading enablement, email, live/demo order/test, funds movement, main merge or publishing/deployment was performed. Validation used only isolated inputs with all TCP blocked; no real provider/model/broker or existing-database request was initiated by those checks. Broader absence of indirect live-client effects cannot be guaranteed because of the frontend exception. Isolated unit processes and compiler workers are not the original application services.

## Records

- This report: `ARX_CHART_TRUTH_CROSSCHECK_SOURCE_DEVELOPMENT.md`.
- Root evidence: `generated-artifacts/arx-truth-crosscheck-validation/`.
- Provenance: `baseline.json`, `download-audit.json`, `upstream-compare.json`, `local-overlap.json`, `merge-review.json`, `scratch-source-manifest.json`.
- Original sequence: `combined-results.json`, `combined-0.log` through `combined-17.log`.
- Corrected scoped runs: `selected-market-lifecycle-corrected.json/.log`, `bindings-corrected.json/.log`; original lifecycle stop in `selected-market-lifecycle-stop.json`.
- Root failures/proof: `combined-11.log`, `wording-guard-source-proof.json`.
- Preservation/summary/checkpoint: `runtime-preservation.json`, `validation-summary.json`, `receipts-sha256.json`, `final-checkpoint.json`.
- Frontend exception: `frontend-runtime-inspection.json`, `frontend-source-watch-inspection.json`; no additional application changes or rollback followed this discovery.
- Earlier browser report remains `ARX_HISTORICAL_FIBONACCI_SOURCE_DEVELOPMENT.md`; none of its incomplete cases was relabeled as a pass.

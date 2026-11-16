# ARX Smart Chart launcher placement — development result

31 October 2026. **Usability import complete; offline functional journeys passed.
Strict performance acceptance did not pass. No launch/parity/first-click-fix claim.**

## Exact source and checkpoints

- Branch: `codex/pr103-smart-chart-development-20261031`.
- Recovery checkpoint: `3b7a044ed4c2432682a0bd5909c8551d96abb7a9`.
- Recovery ref: `codex/backup-before-chart-dock-20261031`.
- Preserved prior application: `765d6eaacf05b081acbb0304d7de3796a248180d`.
- Frozen GitHub report: `36eafc7914d833e518d7caac49df99cd0c4e594b`,
  `portava/arxai`, `codex/chart-assistant-dock-20261031`.
- Tested upstream application: `2f7262980e6be13ccee02c1c4cb65511308a106e`.
- **Combined application commit:
  `d74197cf9f7affbbc5390de53bdc38e2c27ac063`.**
- Immutable actual-application production fixture: `2de65c783027cc0f`.
- Final saved checkpoint is the report/memory-only child of that application
  commit. Its full SHA and clean-tree proof are in
  `generated-artifacts/arx-chart-dock-validation/final-checkpoint.json`
  and the completion response; the report does not attempt to include its own
  self-referential commit hash.

## Scope / preservation

Reviewed the pinned report, four usability commits and all source patches.
Imported exactly **9 files**: 6 production component files and 3 test files.
All six existing files matched the upstream base exactly; three files were new.
Every imported file is byte-identical to its pinned candidate blob.
No concurrent file changes or conflicts were found at initial inspection;
the final scope audit also rejects unrelated changes.

Only launchers move through portals. The assistant panel remains mounted once,
keeping its draft/conversation state through docking and client-side navigation.
Primary chart or fullscreen comparison supplies the current header target;
unmounting comparison restores primary, and leaving charts restores floating
placement. Quick Actions' own close stays above its backdrop. Search handles
Escape in capture phase before the underlying fullscreen chart.

Preserved authentication/sign-out, Replit startup, dependencies/lockfiles,
role/approved-dispatch gates, Truth/safety/funds/backend/database code,
channels/scaling, stream-reader/prefetch and the durable navigation recorder.
Held toolbar-row, supporting-panel-containment, profiling and other performance
experiments were NOT imported. This separate header-docking authorization does
not unhold them.

Evidence prefix throughout:
`generated-artifacts/arx-chart-dock-validation/`.
Source evidence: `scope.json`, `overlap.json`, `preservation.json`,
`upstream-compare.json`, `upstream-report.md`, `candidate/`, `local-before/`.

## Actual combined-source checks

No upstream counts are attributed to this workspace. Checks ran with a dummy
localhost DB/AI configuration and outbound socket guard, not existing DBs.

| Check | Result |
|---|---|
| Full frontend suite | **2,560 passed, 11 skipped, 0 failed**; 176 files passed, 1 skipped |
| Root/project-reference typecheck | PASS |
| API production build | PASS |
| Frontend production build | PASS |
| Account-stream scheduling server regressions | **13 passed**, no failures/skips |
| Recorder/navigation/disclosure regressions | **22 passed**, no failures/skips |
| Safety/static guards | **87/87 passed** |
| Bridge binding syntax fixtures | **7 assertions passed** |
| Exact-file/preservation/whitespace audit | PASS |
| Immutable production fixture build | PASS |

Logs: `dock-frontend-results.json`, `dock-checks-results.json`,
`dock-fixture-results.json` and corresponding `*-N.log` files.
The complete frontend suite includes existing channel/scaling and voice/role
regressions; no real-user sign-in or database/broker acceptance was run.

## Functional browser acceptance

One testing pass used fresh isolated contexts, unchanged pinned preservation
setup, real application routes/components/adapter, exact synthetic historical
OHLC and source/build preflight. External traffic and application mutations
were blocked before navigation; service workers blocked.

- Provided `functional.js`: **PASS** at390×844 and1440×1100. Unique, reachable
  Assistant/Search/Quick Actions in the header, tested control reachability
  without prior closed-launcher tool/Pan obstruction, Search open/close, Quick
  Actions own-button close, fullscreen/exit, restoration off charts, and unsent
  draft retained through client-side Scanner exit/fullscreen. No horizontal
  overflow; full canonical/displayed200-bar data and engine identities unchanged.
- Provided `comparison.js`: **PASS** for actual `/live-chart` → Two charts →
  comparison fullscreen. Search Escape closes only Search; comparison remains
  fullscreen; exit restores primary controls. Both data/engine identities held.
- Supplemental primary fullscreen interactions: **PASS** for all three
  controls, own-button Quick Actions close, Search Escape, Assistant draft
  close/reopen, uniqueness and unchanged data/engine.
- Supplemental comparison interactions verified Quick Actions own-button close,
  Assistant draft retention and unchanged data/engine. **One extra assertion
  returned false:** it read `aria-modal` on the outer comparison wrapper, not
  the nested native chart. The provided nested-chart Escape assertion passed,
  and the saved supplemental screenshot visibly remains fullscreen. The false
  assertion is retained, not relabeled green or rerun.

No message/menu action/order was sent and no media permission/voice activation
occurred. Existing assistant conversation-initialization POST attempts on opening
the panel were blocked, as were activity/alert/scalp writes: **18** primary-context
and **5** comparison-context application mutations returned503. Unknown GETs
remained503 (114 primary,39 comparison), not fake successes. Zero page exceptions;
expected offline console errors131/44 retained. No external request attempts
were recorded in the functional contexts. This does not fix existing automatic
conversation/alert/background-write behavior in the ordinary app.

Evidence: `evidence/driver.cjs`, `partial-results.json`,
`primary-functional-result.json`, `comparison-functional-result.json`,
`acceptance-summary.json`, full network/page-event logs and six screenshots.
Mobile and comparison-fullscreen screenshots were inspected.

## Zoom and existing strict navigation — FAILURES RETAINED

Main ran these separately after the functional browser closed; no owned
build/test jobs were running. The host is shared, not exclusive, and existing
API GET activity was observed. No matched before/after causal diagnosis.

The original frozen probes remain in `upstream-probes/`. Navigation wrapper
adaptations substitute ONLY the expected upstream SHA with the exact combined
source SHA. Zoom has no such literal and is otherwise unchanged. Hashes and
replacement counts are in each report. No100-ms target,150-ms readiness gate,
8-second locator deadline, full-data/engine/visible-plot witness or two-frame
condition was relaxed. No forced DOM click or dwell substituted for immediate
acceptance. Setup, initially prepared browser resources and synthetic80-ms
candle response are offline conditions, not real-provider latency.

### Zoom,20 retained samples

| Condition | ≤100ms | Median / maximum |
|---|---:|---:|
| Normal CPU, n=10 | **10/10** | **37.1 /63.6ms** |
| CDP4× CPU, n=10 | **0/10 — FAIL** | **723.8 /876.5ms** |

All20 completed their range-direction/data/rendering checks; the slowed timing
gate failed. Original sample values/outliers remain in `zoom-workspace.json`.
No upstream normal/slowed zoom numbers are claimed as this environment's result.

### First Scanner navigation,20 retained slots

| Condition / viewport | Recorded | Strict valid | ≤100ms accepted | Actual failure |
|---|---:|---:|---:|---|
| Normal desktop |5|0|0|Click outside150-ms readiness window|
| Normal mobile |5|0|0|Click outside150-ms readiness window|
| 4× desktop |5|0|0|Navigation locator timed out after8000ms; no trusted click|
| 4× mobile |5|0|0|Navigation locator timed out after8000ms; no trusted click|

Normal desktop ready-to-click values:
`1457.4,1478.6,1372.0,1358.3,1614.4ms`;
late-click visible-completion observations:
`514.1,596.0,495.1,436.8,393.1ms`.
Normal mobile ready-to-click:
`1488.9,1269.2,1573.3,1534.2,1380.8ms`;
late-click visible completion:
`407.2,632.4,423.3,327.9,528.9ms`.
These are retained diagnostic observations, **not a valid immediate-first-click
distribution**. The provided valid-only medians remain null.

Every4× attempt timed out waiting for the desktop sidebar Scanner anchor or
mobile bottom-navigation control. Trusted-click, readiness and visible-completion
timings are **null**, not zero. Source-correct response/executing-build completion
was not proven for those slots, despite the correct initial fixture preflight.
No cause or application-vs-runner attribution was established; no synthetic
duration is substituted and no accepted timing median exists.

Both10-slot runs completed their recorder protocol. Full failures, samples,
network/console/runtime evidence: `navigation-1x-workspace.json`,
`navigation-4x-workspace.json`, corresponding eventsJSONL and exact executed
`*-combined.js` wrappers. Both durable journals were copied to
`retained-navigation-receipts/` before stopping the fixture; originals remain
under `builds/2de65c783027cc0f-navigation-receipts/`.
`validation-summary.json` preserves nulls, all rejected slots and journal hashes.

### Runtime / retained setup failures

Workspace Node24.22.1, Playwright1.64.1, Chromium152.0.7977.64,
`/repl/tools/bin/chromium`, headless, slowMo0, DPR1, service workers blocked.
Applied CDP1×/4× conditions; browser reset to1×/closed after each run.
Host/cgroup/load, actual hardware/browser metadata, source/build, driver/probe
hashes and180-second driver /240-second outer-shell deadlines are archived.
No measurement hit an outer deadline; the slowed failures were the unchanged
inner8-second locator timeouts. Two frames are not physical paint.

Retained pre-launch/setup/reporting failures:

- `zoom-attempt0-wrapper-failure.txt`: the outer wrapper wrongly expected a SHA
  literal in zoom. Limited that substitution requirement to navigation; exact
  build/source preflight and original zoom gates remained intact. No browser/sample.
- `zoom-attempt1-git-guard-workspace.json` and error sidecar: isolated `git status`
  attempted an optional index lock and was stopped by Git protection before
  launch. Preserved pending receipt; subsequent read-only metadata used
  `GIT_OPTIONAL_LOCKS=0`, not a protection bypass. No browser/sample.
- `additional-helper-failures.txt`: absent tracked setup-path assumption and
  null-rounding report error. Neither changed application code or measurement
  thresholds. All missing slowed values remain null.
- The first final-report commit failed because the stripped child environment
  lacked the workspace-injected Git author identity. The intended files remained
  staged. The normal workspace commit context was used without changing global
  Git identity, credentials, source or test results (`commit-attempt1-error.txt`).

## Served preview / boundaries / remaining gaps

Only managed development frontend was restarted once; Vite7.3.2 ready2195ms.
API/job settings and other workflows were not restarted or changed. HTTP200
transformed-source probes confirmed dock targets, capture-phase Search Escape
and Quick Actions close stacking (`served-source-checks.json` and saved JS).
Actual anonymous `/login` rendered normally;401 session check is expected.
This is not signed-in owner acceptance. Offline functional screenshots show
the real compiled chart; authenticated actual-preview/provider acceptance is
still unverified. Owned browsers and fixture4199 were closed.

The supplied upstream10/10 normal navigation and0/10 slowed navigation results
remain upstream evidence, NOT this environment's result. Prior Replit0/20 loading
acceptance and the old unrecoverable45-second idle timeout remain in
`ARX_NAVIGATION_RECORDER_DEVELOPMENT.md`. Prior slowed-touch channel5/5 timing
failures remain in `ARX_CHART_CHANNELS_DEVELOPMENT.md`; not rerun or declared fixed.
The specific closed-launcher obstruction is resolved in checked offline
viewports, not a full mobile/modal/focus/accessibility certification.

No physical touch/Safari/Firefox/WebKit, full Tab/focus-modal audit, real
provider/freshness/analysis, matched competitor, real-owner or production
acceptance. Historical/safe-mode fixture warnings were not suppressed.
Other earlier M2/zoom-pan/hydration/legacy404/general automatic-write limitations
are not broadly declared resolved by this usability batch.

No main merge, GitHub write, publish/republish/deploy, existing DB migration or
data/account/credential change, email, worker/trading activation, broker/demo/live
test or order. Existing API activity was left untouched. Bulky evidence stays
in the ignored workspace evidence directory, not Git history.

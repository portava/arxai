# ARX development: pending initial chart engine

Completed 31 October 2026. Development only. Functional checks passed; the
single bounded navigation timing slot failed. No speedup, instant-loading,
competitor-parity or launch-readiness claim.

## Source and recovery

- Combined tested application: `e83090cbb14b130a679130d43764670e644d5e15`.
- Branch: `codex/pr103-smart-chart-development-20261031`.
- Recovery checkpoint: `b96382154517ae2acfd2a5267e5625d061d31472`.
- Recovery ref: `codex/backup-before-pending-engine-20261031`.
- Preserved preceding application: `ee4091166a4e909a0c0cf8cabb1eaa9f7dba8445`.
- Older recovery retained: `140121e380c3905eca67d6a0d72ffdd508bc45f9`.
- Pinned upstream report: `14077859889fe58cfbf87103a86e5cd8411e9ce3`;
  application: `db6cf42ff515a8be66ed802c6756c9ebd70c1a2a`.
- Exact ordinary-runtime offline Scanner build: `e881f903011b42c0`, built from
  the clean combined application. No profiling/timeline plugin imported.
- Final report/checkpoint commit is recorded after committing this report in
  `generated-artifacts/arx-pending-engine-validation/final-checkpoint.json`.

Initial and pre-final tracked working trees were clean. No newer/concurrent
tracked edits were detected or overwritten. Exactly two application/test files
changed; both local base Git blobs matched the pinned upstream base, and both
resulting blobs match the pinned candidate byte-for-byte:

- `arxai/artifacts/trading-dashboard/src/components/charts/ARXNativeChart.tsx`
- `arxai/artifacts/trading-dashboard/src/components/charts/ARXNativeChart.tick-stream.test.tsx`

Diff: 70 insertions, 12 deletions. No dependencies, lockfiles, authentication,
sign-out, startup, funds, Truth/safety, recorder, API or job settings changed.
Held mount-budget, toolbar, containment, resize-dedup and other held experiments
were not imported. Upstream diagnostic assets were retained only as ignored
reference evidence; none entered normal application runtime.

## Behavior

The initial pending primary query retains its usable loading/tools shell without
creating an empty engine. Valid candles or a settled empty/error query permit
construction. Later loading, source, symbol and interval changes retain the
existing engine while preserving resets and data ownership. Current selection,
study input, pending unmount and exactly-once late linked-range registration are
covered by the six added component cases. Existing chart/dock/cockpit behavior
outside the two-file scope is unchanged.

## Exact combined-source validation

| Lane | Pass | Fail | Skip |
|---|---:|---:|---:|
| Frontend | 2623 | 0 | 11 |
| Pure API chart/truth contracts | 76 | 0 | 0 |
| Account scheduling | 13 | 0 | 0 |
| Recorder/navigation/disclosure | 22 | 0 | 0 |
| Guards | 87 | 0 | — |
| Binding assertions | 7 | 0 | — |
| Distinct offline browser assertion coverage | 39 | 0 | — |

Frontend: 179 passing files, one skipped file. Root/project-reference and leaf
typechecks, API build and dashboard build passed. Existing large-chunk warning
retained. The preceding combined frontend had 2617 passes; this scope added six.
Upstream's 2625 passes and local timing results are not workspace results.

### Browser coverage and count audit

Native headless Chromium, fresh isolated contexts, service workers blocked.
Pinned flow contains 18 checks spanning desktop 1440x1100 and mobile-width
390x844. It passed twice. The raw tester summary mistakenly called both
executions 36 distinct checks. The audited total is **39 distinct checks**
(18 pinned + 5 empty/recovery + 6 corrected error/recovery + 10 symbol/interval),
with **57 passing assertion executions** when the repeated pinned flow is counted.
Do not describe 57 as unique coverage. A stale raw verified-error subfield says
4; the authoritative corrected error receipt contains six passing checks.

Verified: no engine before the held 200-bar response; usable Studies; same input,
Donchian text and focus after first data; visible/unobscured focused field; all
canonical and displayed time/OHLC values equal; engine retention and tool reset
after genuine synthetic-source replacement; empty settlement and reload recovery;
all initial error attempts held at 503 until explicit reload, then recovery with
the same engine; actual M5 and GBPUSD selection with stale tools reset and exact
source witnesses; no document overflow or page exceptions.

Retained intermediate harness failures:

1. Empty-state matcher omitted the actual “No native candles available” copy.
2. Results collection failed to await a fixture-log promise after four checks.
3. Regex escape syntax error stopped a runner before browser launch.

Corrections were confined to ignored test wrappers. The weaker earlier error
exercise is retained and superseded by the six-check corrected error receipt.
A separate read-only reporting inspection hit an integer/list assumption; its
failure and correction are recorded separately, not as an application failure.
No application source repair or relaxed gate was needed.

Functional evidence contexts recorded 286 unimplemented GET 503s and 33 blocked
automatic mutation 503s, including alert scan, scalp focus and activity ping.
No external request or WebSocket attempt was observed there. No tester clicked
analysis, Scan, voice, trading or order actions. Top-bar `/api/me/symbols` remains
503/unavailable in this fixture; the separate Symbols-tab journey passed.

## One bounded timing slot — FAILED, no rerun

One normal-CPU desktop slot of the unchanged ten-slot journal was executed after
owned builds/tests and functional browsers finished. No second/slowed/mobile
timing attempt was started. No false completion event was emitted.

| Observation | Result |
|---|---:|
| Valid / invalid / unstarted | **0 / 1 / 9** |
| Ready to trusted click | **1393.0 ms**, fails 150 ms gate |
| First recorded chart container | 166.3 ms after click |
| Recorded source-complete witness | 239.3 ms after click |
| Visible source-correct completion, two frames | **239.3 ms**, exceeds 100 ms |
| Source and visibility witnesses | true / true |
| Valid-only median / max | **null / null**, not zero |
| Witness cost | 2.1 ms |

Browser Resource Timing records the first candle responseEnd **551.1 ms before**
click, request start 1304.5 ms before click, and last recorded asset responseEnd
229.4 ms before click. These are browser observations, not route.fulfill
preparation or proof of module evaluation/cache/React readiness. A 150 ms long
task shortly after click and a later 50 ms task overlap completion; overlap does
not identify their CPU cause. No new profiler trace was collected.

Runtime: Node v24.22.1; Playwright 1.64.1; Chromium 152.0.7977.64 at
`/repl/tools/bin/chromium`, headless, slowMo 0, controlled CPU rate 1. Host reports
8 logical CPUs, cgroup `800000 100000`, and no recorded cgroup throttling at start.
Host load at start: 0.50 / 1.04 / 0.98. Other host scheduling/contention is not
fully observable. Driver deadline 180 s, phase deadline 60 s, sample timeout 8 s;
outer GNU timeout 240 s with 10 s termination grace. No deadline was reached.
Node-call bookkeeping remains; tracing was removed, so this is not a matched
comparison to prior traced diagnostics. No causal speedup/regression inference
is justified from this one invalid sample.

Preserved historical failures include preceding source
`49d13ac49fff432db8ff947e93feecf7c4aa5bc2` at 0 valid / 4 invalid / 16 unstarted,
earlier 40 invalid navigation slots, both 180-second sustained-zoom deadlines,
older first-load/slowed-touch failures and the unrecoverable idle timeout.
Their raw receipts remain intact in the earlier validation folders. This
feature does not resolve or relabel them.

## Served development and remaining limitations

Only the development frontend was restarted, once, after source checks passed.
Vite started cleanly; the shared preview router returned the executable native
chart module with the new pending-engine anchors. Anonymous `/login` rendered;
its expected identity 401 is not authenticated acceptance.

**API activation remains deferred.** No API/worker restart occurred. The prior
volume correction retains source/build/offline coverage but still lacks
refreshed-process acceptance. No production/publication action, main merge,
existing-database/account/credential change, migration, worker/settlement/trading
enablement, email, funds movement, order or broker/live/demo test was performed.
The owned offline fixture and browsers were stopped.

Actual owner-authenticated/provider and published-app acceptance remain
unverified. Actual multi-chart/comparison/linked-range browser coverage remains
unverified; the component linked-range regression passed. Physical-device and
keyboard acceptance, whole-chart mobile fit while editing Studies, replay
journeys, prior M2 no-data and ordinary unblocked alert-POST behavior are not
established. No parity or launch-readiness claim.

## Evidence

All current evidence: `generated-artifacts/arx-pending-engine-validation/`.

- `source-commit.txt`, `scope-audit.json`, `preservation-audit.json`
- `validation-summary.json`, `browser-count-audit.json`, `evidence-sha256.json`
- `pending-frontend-*`, `pending-checks-*`, `pending-fixture-*`
- `functional/validation-report.json` (raw, retains count inconsistencies)
- `functional/second-attempt-results.json`, `continuation-results.json`,
  `error-corrected-results.json`, executed wrappers and screenshots
- `navigation-only/results.json`, `events.jsonl`, executed probe and the
  build's durable navigation receipt journal; `timing-launch.log`
- `served-source-checks.json`, `frontend-startup.json`,
  `anonymous-login-smoke.jpg`, `fixture-shutdown.json`
- `reporting-inspection-failure.txt`, `final-checkpoint.json`

Preceding report and all earlier failures remain in
`ARX_CHART_INITIAL_BINDING_DEVELOPMENT.md` and its linked evidence.

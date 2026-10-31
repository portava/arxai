# ARX development — price-only scale and editable extended channels

31 October 2026. Development preview only. **Feature behavior verified offline;
one strict browser timing probe failed. No first-click fix, parity or launch-ready
claim.**

## Saved source and recovery

- Branch: `codex/pr103-smart-chart-development-20261031`.
- Recovery checkpoint: `5e98c0aa3361a9ccd6588660f2e0b64533b6fab9`.
- Recovery ref: `codex/backup-before-chart-channels-20261031`.
- Pre-update application: `f3467de7c5f60038a139a60f00abe56d563f0cc4`.
- Imported tested application: `b43b0b9f63c5bfb1f89c38a9b5905e5e0fe2a4db`
  from `portava/arxai`, `codex/chart-channel-extensions-20261031`.
- Frozen upstream report/backup: `53203e8693f83bff6ab1af7bc2d2ca7f1813167a`.
- **Combined application/source commit tested here:
  `765d6eaacf05b081acbb0304d7de3796a248180d`.**
- Immutable actual-Scanner fixture: `90fab64f39187926`, normal production React,
  with actual imported application components and chart adapter, not a chart mock.
- The final report/memory-only checkpoint is the commit containing this report.
  Its exact full SHA and clean-tree proof are retained separately in
  `generated-artifacts/arx-chart-channel-validation/final-checkpoint.json`
  and returned in the completion response; no self-referential commit hash is
  inserted into its own tracked report.

## Selective import / preservation

The three upstream feature reports were reviewed before editing. Only 19 files
were imported: 9 production chart/replay files, 7 frontend test files and 3 QA
support files. All 17 pre-existing files matched the upstream base byte-for-byte
before import; two QA scripts were new. Every imported file matches its pinned
candidate Git blob and SHA256. No whole-workspace replacement, branch reset,
upstream merge, dependency/lockfile import or GitHub write occurred.

No concurrent changes were found before integration. The final scope audit
checks preservation outside those 19 files plus this report and three memory
documents. Authentication, sign-out, startup, Truth/safety, cockpit funds,
stream-reader, candle prefetch, dependencies, test commands, backend/database
source, API/job settings and the durable navigation recorder remain unchanged.
The held toolbar-layout, supporting-panel-containment, React profiling and
other held performance/navigation changes were excluded.

Files/blob evidence: `generated-artifacts/arx-chart-channel-validation/`:
`import-manifest.json`, `preservation.json`, `upstream-compare.json`,
`base/`, `candidate/` and `upstream/docs/`.

## Features now in the development Scanner source

- **Scale price only**: opt-in automatic fitting to price, excluding overlay
  studies from fitting without removing/re-scaling them onto another axis.
  Separate oscillator panes remain separate. Turning it off restores full fit;
  preferences/templates/replay carry the explicit setting. Default stays off.
- **Parallel channel**: three real candle/price anchors, editable baseline and
  offset, three handles, whole-object editing, locking, undo/redo and saved browser
  reload. Incomplete placement is not committed. No candle-history changes.
- Per-channel **Extend left**, **Extend right**, **Middle line**, off by default.
  Extensions follow time direction regardless of anchor order; the midpoint is
  halfway between projected rails, including logarithmic geometry.
- Existing plain-text library attribution remains; no graphic logo was added.

## Actual combined-source checks

All commands used the isolated validation environment with dummy localhost DB/
AI endpoints and an outbound socket guard; no existing database/provider was
needed. Full output and durations are in the named result JSON/log files.

| Check | Actual result |
|---|---|
| Full frontend Vitest, maxWorkers=2 | **2,554 passed, 11 skipped, 0 failed**; 174 files passed, 1 file skipped |
| Root/project-reference typecheck | PASS |
| API production build | PASS |
| Frontend production build | PASS |
| Cockpit account-stream scheduling regressions | **13 passed**, 0 failed/skipped |
| Recorder/navigation/disclosure Node regressions | **22 passed**, 0 failed/skipped |
| Safety/static guards | **87/87 passed** |
| Bridge binding syntax fixtures | **7 assertions passed** |
| Two imported browser-script syntax checks | PASS |
| Scoped blob/preservation audit and diff whitespace | PASS |
| Immutable actual-Scanner production fixture build | PASS |

These are local combined results, **not** the upstream 2,559-test result.
No DB integration, broker/live/demo or real-user authentication acceptance ran.
Evidence: `chart-frontend-results.json`, `chart-checks-results.json`,
`chart-fixture-results.json`, their `*-N.log` files and `validation-summary.json`.

## Browser attempts — all retained, not all green

Three fresh offline contexts per attempt; all preconditions matched source
`765d6eaa…`, clean immutable build `90fab64f39187926`, real adapter, 200 canonical
and displayed synthetic historical candles, production runtime and blocked
service workers. External requests and app mutations were blocked before
navigation. Synthetic browser-local drawing/preferences storage only.

### Initial fixture-context error

The first contexts omitted the fixture's existing storage-preservation opt-in.
Its fresh-navigation reset therefore cleared test studies/drawings on reload:

- Price probe: 30-second readiness timeout before timing samples.
- Manual channel: 20 placements retained, then 15-second persisted-reload timeout.
- Extensions: 24 settings samples retained, then 15-second persisted-reload timeout.
- Mobile step: **skipped** because the saved channel prerequisite was absent.

These are failed/incomplete runs, not silently discarded. Full reports/events/
screenshots are archived under `attempt1-initial-context-default/` (initial root
copies also remain). Only the harness's existing opt-in was enabled for a
corrected complete run; application code, fixture setup source and acceptance
gates were not changed. There was no retry to hide the subsequent timing failure.

### Corrected preservation contexts

| Flow | Functional outcome | Recorded timings, milliseconds |
|---|---|---|
| Price-only, 1× CPU | PASS; 20 measured + 4 warmups | median 45.9, p95 46.5, max 46.7 |
| Price-only, 4× CPU | PASS; 20 measured + 4 warmups | median 80.1, p95 92.0, max 94.4 |
| Channel placement, 1× mouse, n=5 | PASS | median 30.7, max 35.1 |
| Channel placement, 1× emulated touch, n=5 | PASS | median 83.6, max 87.9 |
| Channel placement, 4× mouse, n=5 | PASS | median 63.7, max 96.1 |
| Channel placement, 4× emulated touch, n=5 | Geometry/data PASS; **timing FAIL** | **101.7–140.2**, median 117.6; 0/5 below 100 |
| Extensions/midpoint, 1× CPU, n=12 | PASS | median 46.4, p95/max 47.5 |
| Extensions/midpoint, 4× CPU, n=12 | PASS | median 76.3, p95/max 84.3 |
| Mobile-width focused checkbox + Space twice | PASS | Functional, not a navigation benchmark |

**The unchanged manual-channel probe's overall verdict is FAIL**, due to all five
4×-touch timings exceeding its 100-ms gate. No bottleneck/cause was established
by these samples. No held optimization was imported to make it green. The
upstream “24 clicks below 50 ms” result is not claimed here.

All 20 placements passed their actual rendered geometry/data checks; partial
placements did not persist. Width-handle editing, single-step undo, linear/log
parallel rails and saved reload of 20 drawings/40 strokes passed. The extension
probe separately passed actual finite/left/right/both/midpoint geometry,
undo/redo, lock-disabled settings, logarithmic midpoint and saved reload.
Canonical/displayed OHLC, chart/series identity and logical range invariants held.
The inherited base channel probe's static “extensions absent” limitations text
predates the separately verified extension flow and is not current feature status.

At 390×844, both focused Space toggles passed on the same saved channel,
200 bars/engine identity were preserved, 3 strokes remained, and no horizontal
page overflow was found. This is not physical touch-device/Safari certification
or a complete keyboard Tab-order audit. Existing floating-assistant overlap
remains visible. Screenshots were inspected.

Corrected flows blocked 7, 5 and 6 attempted app mutations respectively;
unknown GETs stayed 503, not fabricated successes. Zero page exceptions;
expected offline 503 console errors remain in full event logs. This does not
repair the ordinary application's unsolicited alert/analysis POST limitation.

### Runtime and receipts

Node 24.22.1; Playwright 1.64.1; Chromium 152.0.7977.64 at
`/repl/tools/bin/chromium`; headless, slowMo=0, DPR=1. CDP 1×/4× conditions
are explicit and reset to 1×. Viewports: 1440×1100, extension desktop1440×1600,
mobile390×844. Host/load/CPU observations and outer240-second shell /
180-second per-flow driver deadlines are archived, not inferred from Mac runs.
No profiling build, CPU-stack diagnosis or real-device paint acceptance.

Evidence prefix: `generated-artifacts/arx-chart-channel-validation/`:

- `offline-browser-driver.cjs`, `browser-runtime-config-attempt2.json`,
  `browser-prerun-runtime.txt`, `fixture-provenance.json`, `builds/90fab64f39187926/`.
- `flow1-price-scale-preserve-report.json`, `flow2-channel-preserve-report.json`,
  `flow3-extensions-mobile-preserve-report.json`, corresponding preconditions,
  `*-events.jsonl` / `*-page-events.jsonl` and screenshots.
- `all-feature-timing-records.json`: **136 retained records**, including 8 price
  warmups, the corrected samples and initial channel/settings samples.
- `flow1-price-scale-preserve-enabled.png`, `flow2-channel-preserve-final.png`,
  `channel-options.png`, `channel-options-mobile.png`.
- The first reporting-only footer parser missed ANSI colors; its failure is in
  `summary-postprocess-attempt1-error.txt`. Only that parser was fixed; no test rerun.
- The optional final `ss` shutdown check could not run because `ss` is not
  installed. A Python loopback closed-port check was used instead; no installation,
  application change or test rerun was needed.

## Served development frontend / remaining limits

Only managed `artifacts/trading-dashboard: web` was restarted, once. Vite7.3.2
reported ready in1747ms; API and other workflow/settings were not restarted.
HTTP200 transformed modules contain executable price-only/channel option
controls and adapter implementation (`served-source-checks.json` plus saved JS).
Anonymous actual-preview `/login` rendered normally; its401 session check is
expected (`anonymous-login-smoke.jpg`). That is **not authenticated-owner
Scanner acceptance**; chart journeys above used the offline production fixture.
Owned fixture server/browser processes were stopped afterward.

Previous failures remain unchanged in `ARX_NAVIGATION_RECORDER_DEVELOPMENT.md`:
the original 20 failed remote first-navigation samples (ready-to-click
666.6–796.6ms, visible completion122–181.5ms), the unrecoverable old45-second
idle timeout with unknown unfinished sample count, and the later 20 retained
workspace immediate/idle attempts with **0/20 below100ms**. No first-navigation
test was rerun here. Candle arrival, module evaluation, actionability and visible
completion remain different measurements; these feature-click samples do not
demonstrate that first visit is fixed.

Earlier M2 no-data, inconclusive zoom/pan, mobile assistant overlap, hydration
warnings, legacy-page404s and ordinary alert-POST limitations remain explicit;
none is declared resolved by this scope. Real accounts/providers, physical
devices, Firefox/WebKit/Safari and complete Tab traversal were not accepted.

The log collector incidentally surfaced earlier deployment API/DB/worker errors
dated19:20–19:58. They were not investigated or remediated in this development
task; no production health or global worker-disabled claim is made.

No main merge, publish/republish/deployment, existing DB change/migration,
credential/account change, email, funds movement, broker call/test/order, or
worker/trading enablement occurred. API/job settings remain as found. Bulky
receipts stay in the ignored workspace evidence directory, not Git history.

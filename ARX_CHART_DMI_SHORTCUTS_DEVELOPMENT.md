# ARX development: drawing shortcuts and Wilder DMI / ADX

Completed 31 October 2026. Development-only selective import and validation.
No new navigation/interaction latency benchmark, launch-readiness, architecture
completion or TradingView/MT5 parity claim.

## Exact source and recovery

- Combined application: `831ec35ca63b0dc3f027da478fddcd3480e4cc41`.
- Branch: `codex/pr103-smart-chart-development-20261031`.
- Recovery: `6243c71939ad9801e9de044e75a33c208ad18595`.
- Recovery ref: `codex/backup-before-dmi-shortcuts-20261031`.
- Preceding application retained: `e83090cbb14b130a679130d43764670e644d5e15`.
- Older recovery retained: `b96382154517ae2acfd2a5267e5625d061d31472`.
- Pinned upstream report: `bcba1b6115f1333210167f93c6d2f7b4a3d25d02`.
- Upstream application: `d83a02d773743990704465548af7cea556851d0c`,
  including accepted drawing-shortcut work through `c475c736`.
- Exact clean ordinary-runtime Scanner fixture: `266855fc74b2d81f`.
- Final workspace/report commit is recorded after this report is committed in
  `generated-artifacts/arx-dmi-shortcuts-validation/final-checkpoint.json`.

Initial and pre-report tracked working trees were clean. No newer/concurrent
tracked work was detected or overwritten. All twelve modified file bases matched
their upstream base blobs; the new DMI test file was absent. All thirteen
resulting files match the pinned candidate byte-for-byte. No whole-workspace
replacement, checkout/reset, main merge or upstream push occurred.

## Selective scope and preservation

Only these paths under `arxai/artifacts/trading-dashboard/src/` changed:

- `components/charts/ARXNativeChart.tsx`
- `components/charts/ChartStudySettings.tsx` and `.test.tsx`
- `components/charts/ChartWorkbenchTools.tsx` and `.test.tsx`
- `lib/chart-engine/chartAnalysisRenderer.ts` and `.test.ts`
- `lib/chart-engine/chartDrawingEditor.ts` and `.test.ts`
- `lib/chart-engine/chartStudies.ts` and `.test.ts`
- `lib/chart-engine/chartWorkspace.ts`
- New `lib/chart-engine/chartDmi.test.ts`

All existing auth/sign-out/startup, dependencies/lockfiles, Truth, funds, safety,
chart/dock/startup, recorder, API and job differences outside that scope remain
unchanged. Held mount-budget, resize-dedup, toolbar/layout/containment and other
held performance experiments were excluded. Downloaded upstream reports/probes
remain ignored evidence; diagnostic instrumentation was not imported into the
ordinary application.

## Behavior and conventions

The focused drawing-selection plot owns Delete/Backspace and available drawing
history actions: Ctrl/Cmd+Z undo, Shift+Z redo, Ctrl+Y redo. Text fields,
background charts, locked/hidden objects, composing/repeated/claimed events and
unfinished gestures are guarded. Actual deletion/update/undo/redo feedback uses
the same browser-local persisted history as the toolbar. Pan-only/global-hidden
modes and the existing explicit toolbar deletion policy are unchanged.

DMI is the nineteenth study type; the five original starter studies are
unchanged. It provides separate +DI (green), minus DI (rose), and configurable
ADX lines in one 0–100 pane. DI and ADX smoothing lengths are independent integers
1–1000, default 14/14, retained through settings/duplication/reload. ADX is strength,
not direction, calibrated confidence or trade permission; no threshold, order,
AI approval or execution policy is introduced.

Wilder convention: first bar has no transition. Positive/negative movement uses
the strictly dominant positive high/low change; ties contribute zero. True range
is max(high-low, absolute high-prior-close, absolute low-prior-close). Seed TR and
movements with the arithmetic mean of a full DI-length transition window, then
use previous+(input-previous)/length. DI divides smoothed movement by smoothed TR;
zero TR produces zero DI. DX divides the absolute DI difference by their sum;
zero sum produces zero DX. ADX seeds a full independent DX window and uses the
same recurrence. On zero-based history first DI is at `period`, first ADX at
`period+signal-1`; earlier values are blank. Older-history loading and forming-bar
revisions may change seeded values. No future candles are read.

The legacy bit-identical reference remains scoped to its original eighteen study
kinds; no old kind/assertion was removed. DMI uses its own independent batch
oracle and hand-derived vectors. No exact provider/platform seed equivalence is
established. Individual +DI/minus-DI styling, alternate indicator timeframe and
additional ADX variants were not added.

## Exact combined-source checks

| Check | Pass | Fail | Skip |
|---|---:|---:|---:|
| Full frontend | 2658 | 0 | 11 |
| Pure API chart/truth contracts | 76 | 0 | 0 |
| Account scheduling | 13 | 0 | 0 |
| Recorder/navigation/disclosure | 22 | 0 | 0 |
| Guards | 87 | 0 | — |
| Bindings | 7 | 0 | — |
| DMI actual-Scanner browser probe | 30 | 0 | — |
| Drawing actual-Scanner browser probe | 28 | 0 | — |

Frontend: 180 passing files, one skipped file; 35 more passes than the preceding
combined source. Root/project-reference and leaf typechecks, API build and
dashboard build passed. Existing large-chunk warning remains. Upstream's 2660
passes and forty scoped interaction measurements are not workspace results.

Each browser probe ran once; 58 executed, viewport-qualified assertions passed.
The DMI probe checked all three actual plotted series against independent
calculations over the full 200 canonical/displayed candle values, default 14/14,
edited 7/21, duplicate 7/3, removal, reload and 390px width. Drawing coverage spans
1440x1100 and 390x844: focus, Backspace/Delete, Ctrl/Meta undo, Shift+Ctrl+Z/Ctrl+Y,
typing protection, lock protection, deletion feedback and unchanged engine/data.
This drawing probe uses a horizontal level, not a text note.

Two supplemental observations are separate from the 58 formal assertions:
Delete after hiding a drawing retained it in storage; Delete between Trend line
anchors did not prematurely persist an object. A mobile visibility observation
recorded the DMI pane at y=249–332 and fixed navigation starting y=787 in a 390x844
viewport. All three lines and the study bottom were visible above navigation
after scrolling; this does not prove whole-page first-entry fit or physical
phone/keyboard acceptance.

One supplemental wrapper first selected the nonexistent value `trendline`; the
narrow corrected continuation selected the actual Trend line label. The original
failure and both runners remain. No application fix or relaxed assertion was
needed. Both primary browser probes reported zero page exceptions. Expected 503
console errors were retained (72 DMI, 74 drawing): unsupported fixture GETs and
automatic POSTs such as alert scan, scalp focus and activity ping were blocked,
never success-mocked. No intentional analysis/Scan, voice, order or trade action
was clicked. Top-bar `/api/me/symbols` remains an unsupported fixture 503.

## Performance: no new benchmark, prior failures still open

No new navigation slots were planned or executed. The known runtime failed the
unchanged 150ms readiness gate, and this functional import offers no evidence
that the measurement environment can now satisfy it. Neither early feedback nor
calculator-only timings were substituted for visible source-correct completion.

Preceding application `e83090cb` remains **0 valid / 1 invalid / 9 unstarted**:
1393ms ready-to-click; container 166.3ms; source-correct visible completion
239.3ms against 100ms; valid median/max null, not zero. Earlier source `49d13ac4`
remains 0 valid / 4 invalid / 16 unstarted. Older forty invalid navigation slots,
both 180-second sustained-zoom deadlines, slowed-touch/first-load failures and
the unrecoverable idle timeout remain recorded and unresolved. No outliers or
failed samples were discarded or attributed to this new source.

## Served development, activation and remaining gaps

Only the development frontend was restarted, once after checks passed. Vite
started cleanly; shared-router GETs returned new executable DMI, drawing-key and
settings module anchors. Anonymous `/login` rendered; expected identity 401 is
not owner-authenticated acceptance.

**API activation remains deferred.** No API or worker restart occurred. The
previous volume correction's refreshed-process status remains unverified.
No production/publication/deployment action, main merge, existing database,
account or credential change/migration, worker/settlement/trading enablement,
email, funds movement, order or provider/broker/live/demo test was performed.
The owned fixture and browsers were stopped; existing managed services were
otherwise left alone.

Actual comparison-chart keyboard isolation, unfinished pointer-drag browser
acceptance, text-note-specific browser shortcuts and DMI replay remain
unverified; corresponding component/generic tests are not substituted as browser
acceptance. Catalog/starter behavior has source/unit coverage, not a separate
browser journey. Real-owner/provider, physical-device and published-app
acceptance remain unverified. Ordinary unblocked automatic alert-POST behavior,
prior M2 no-data and old navigation/zoom limitations remain open.

Separate optional offline follow-ups were proposed for comparison/drag/text-note
keyboard coverage and DMI replay; they were not implemented or activated here.

## Evidence

Root: `generated-artifacts/arx-dmi-shortcuts-validation/`

- `source-commit.txt`, `scope-audit.json`, `base-blobs.json`,
  `preservation-audit.json`, `source-blobs.json`
- `validation-summary.json`, `measurement-decision.json`,
  `evidence-sha256.json`, `final-checkpoint.json`
- `dmi-frontend-*`, `dmi-checks-*`, `dmi-fixture-*`
- `functional/audited-summary.md`, `run-summary.json`,
  `dmi-raw-results.json`, `drawing-raw-results.json`
- `functional/guard-continuation-failed-attempt.json`,
  `drawing-guard-continuation-results.json`, retained executed probes/runners
- `functional/mobile-visibility-results.json`, screenshots and request logs
- `served-source-checks.json`, `frontend-startup.json`,
  `anonymous-login-smoke.jpg`, `fixture-shutdown.json`

Prior raw timings and failures remain under
`generated-artifacts/arx-pending-engine-validation/` and earlier report folders.

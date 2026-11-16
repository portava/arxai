# ARX development: individual study lines and earlier selected candles

Completed 1 November 2026. Development-only selective update. No new navigation
benchmark, provider acceptance, deployment or launch-readiness claim.

## Exact source and recovery

- Application: `07199ca96df53f6af1db1daa9feb723c509b0638`.
- Branch: `codex/pr103-smart-chart-development-20261031`.
- Recovery checkpoint: `e134a2203fffebcaa4dd6322532016a4922395f5`.
- Recovery ref: `codex/backup-before-early-candles-20261031`.
- Prior application preserved: `831ec35ca63b0dc3f027da478fddcd3480e4cc41`.
- Older recovery `6243c71939ad9801e9de044e75a33c208ad18595` remains retained.
- Upstream report head: `ea5eaef115b58e2efd4671749b6863e30bea3a3d`.
- Upstream tested source: `61f2577bfc333be3ebd420562576c44c3537880e`.
- Clean ordinary-runtime Scanner fixture: `b78533cd20ef580b`.
- Final report/checkpoint commit is recorded after commit in
  `generated-artifacts/arx-early-candles-validation/final-checkpoint.json`.

Initial working tree, application commit and pre-report tree were clean; no
newer/concurrent tracked edits were found or overwritten. All twelve touched
files matched their upstream base. All twelve results match both the saved report
head and tested-source blobs exactly. No wholesale replacement, branch reset,
main merge or upstream push occurred.

## Scope, behavior and preserved differences

Only these files under `arxai/artifacts/trading-dashboard/src/` changed:

- `components/charts/ChartStudySettings.tsx` and `.test.tsx`
- `components/layout/NavSurfaces.investor.test.tsx`
- `components/layout/NavSurfaces.normalUser.test.tsx`
- `hooks/useScannerNavigationWarmup.ts` and `.test.tsx`
- `lib/chart-engine/chartAnalysisRenderer.ts` and `.test.ts`
- `lib/chart-engine/chartStudies.ts` and `.test.ts`
- `lib/chart-engine/chartWorkspace.ts` and `.test.ts`

All other authentication/sign-out, startup, dependencies/lockfiles, Truth,
safety, funds, drawing/dock, recorder, API and job differences are unchanged.
Held experiments were excluded. The updated observer was copied only into ignored
`fixture/witness.ts` and imported by the isolated fixture entry; the ordinary
application and its diagnostic tooling paths were not instrumented or changed.

Each study instance exposes per-channel visibility, color, width 1–3 and
solid/dashed/dotted line appearance. Hidden lines retain calculated and updating
values, labeled hidden in the data window. Duplication and browser-local reload
preserve independent settings. Reset removes overrides and restores inherited
appearance; it does not reset numerical inputs or the study's base color.
MACD histogram bars expose visibility only, preserving positive/negative sign
colors. Hiding all channels intentionally retains the study pane.

Appearance-only changes retain calculator checkpoints and series on the existing
safe incremental path; changed calculation inputs still force appropriate
recalculation. Existing pane/order reconciliation may rebuild. This is not an
O(1) end-to-end claim or a formula change.

For allowed, visible, non-data-saver contexts, the existing selected 200-candle
read starts after access is known rather than waiting for idle. Route code still
waits for idle or explicit navigation intent. Query key/transport, five-second
freshness budget, original response evidence and permissions are unchanged.
Desktop/mobile/navigation share the request. No new loop, chart engine, chart
tick stream, position read, analysis or order is started by this hook.

Tradeoff: one small read may now occur during a visit that ends before idle.
Hidden/data-saver/investor/pending contexts do not automatically warm. Explicit
allowed intent keeps its existing behavior. Lost access cancels queued route
warming, not a newly invented shared-query cancellation policy. Late responses
remain context-keyed; late idle callbacks do not renew evidence or reread candles.

## Exact combined-source checks

| Check | Pass | Fail | Skip |
|---|---:|---:|---:|
| Full frontend | 2710 | 0 | 11 |
| Pure API chart/truth contracts | 76 | 0 | 0 |
| Account scheduling | 13 | 0 | 0 |
| Recorder/navigation/disclosure | 22 | 0 | 0 |
| Guards | 87 | 0 | — |
| Bindings | 7 | 0 | — |
| Appearance browser probe | 18 | 0 | — |
| Warmup browser probe | 8 | 0 | — |
| Delayed-data/source/focus browser probe | 18 | 0 | — |

Frontend: 180 passing files, one skipped file; 52 additional passes over the
prior combined source. Root/project-reference/leaf typechecks, API build,
dashboard production build and immutable fixture build passed. Existing
large-chunk warning remains. Upstream 2712 is not the combined-source count.
Focused tests are included in, not added to, the full frontend total.

## Actual Scanner browser evidence and retained failures

Native headless Chromium 152.0.7977.64, desktop 1440x1100 and phone-width 390x844;
fresh isolated contexts, synthetic history, external HTTP/WS blocked and mutating
requests refused with real 503 responses. These are not real-owner sessions.

Final corrected probes: 44 passing raw assertions, zero final assertion failures,
all completed. Shared source/fixture assertions overlap; 44 is not a unique
feature total. Each defined upstream probe completed once after setup correction.

Appearance checked actual library options, hidden +DI, custom minus-DI color,
width and dash, dotted ADX, saved reload, independent duplicate, hide-all/reset,
retained calculator/series and unchanged plotted values/candles. Phone-width
overflow checks passed. Warmup observed one selected EURUSD/M15/200 GET on the
dashboard, no hidden chart canvas or chart tick stream, reuse on navigation,
exact canonical/displayed candles and unavailable feed remaining non-live.
Delayed-data checks covered visible focused study search, first binding,
source reset, same-engine continuity and exact OHLC at both widths.

The first setup for each of three probes failed with ERR_CONNECTION_REFUSED
because the fixture ended with its launching shell: zero assertions executed in
those attempts, and probe checks were not reached. Original receipts/screenshots
remain. The corrected runner owned the fixture lifecycle; no application change,
source/visibility gate relaxation or timing retry was involved.

Also retained: one initial Git staging command expanded a nonexistent `.tsx`
path and staged/committed nothing; explicit audited paths corrected it. One
summary parser failed on ANSI formatting; normalized parsing read the same
unchanged passing logs. Neither was an application/test failure.

All mutating requests were blocked: 8/5/8 across appearance/warmup/functional.
The ordinary app attempted automatic analysis-related GETs and scan POSTs;
no analysis result or successful mutation was supplied. The warmup probe does
not explicitly prove the absence of every analysis-related request. No manual
analysis, trading, voice, onboarding/preference save or provider action occurred.
Unsupported GETs including `/api/me/symbols` remain fixture 503s. Console errors
86/55/78 were retained; zero page exceptions, failed requests or external requests.
No MACD histogram-specific browser acceptance is claimed; source/unit coverage
does cover sign preservation and visibility-only behavior.

## Performance and remaining acceptance limits

No new navigation slots or latency benchmarks were planned/executed. Original
150ms readiness and 100ms fully source-correct visible-completion gates remain.
No feedback timestamp or empty canvas was substituted for visible completion.

Prior source `e83090cb` remains **0 valid / 1 invalid / 9 unstarted**:
1393ms readiness, 239.3ms source-correct visible completion; valid median/max
remain null. Earlier 0 valid / 4 invalid / 16 unstarted, forty invalid slots,
sustained-zoom deadlines, slowed-touch/first-load and idle-timeout failures remain.
No failures, nulls, outliers or unfinished slots were discarded.

The archived upstream sixty samples belong only to upstream tested source:
twenty normal attempts passed 100ms, all forty slowed attempts failed. Reported
slowed medians improved from approximately 330–366ms to 239–251ms, not to 100ms.
No local-Mac result is attributed to this workspace or the served owner app.

Real-owner/provider, published-app and physical-device acceptance remain
unverified. Comparison shortcuts, unfinished pointer drags, text-note-specific
shortcuts and DMI replay are not resolved by this update. No instant-loading,
platform parity, architecture-completion or launch-ready claim.

## Served development and activation boundaries

Only the development frontend was restarted, once after combined checks passed.
Vite started cleanly. Four actual shared-router executable modules returned
200 with the new warmup/appearance/calculator/preferences anchors. Anonymous
`/login` rendered with expected identity 401; this is not owner sign-in acceptance.

**API activation remains deferred**, including refreshed-process verification of
the earlier volume correction. Existing API process/settings were untouched;
neither API nor workers were started/restarted or enabled. A log snapshot showed
ongoing API rate-limit warnings; no provider/backend acceptance or diagnosis is
inferred. Owned synthetic fixture/browser were closed; port 4199 is closed.

No main merge, publish/republish/deploy, existing-database/account/credential
change or migration, email, worker/settlement/trading enablement, funds movement,
order or live/demo broker test was performed.

## Evidence locations

Root: `generated-artifacts/arx-early-candles-validation/`

- `validation-summary.json`, `core-check-summary.json`, `final-checkpoint.json`
- `scope-audit.json`, `preservation-audit.json`,
  `candidate-tested-source-audit.json`, `upstream-evidence-audit.json`
- `early-frontend-*`, `early-checks-*`, `early-fixture-*`
- `functional/audit-summary.json`, initial `*-raw-results.json` and screenshots
- `functional/corrected/{appearance,warmup,functional}-raw-results.json`,
  corrected probe screenshots and runner logs
- `measurement-decision.json`, `harness-attempts.json`,
  `initial-staging-command-failure.log`, `evidence-sha256.json`
- `frontend-startup.log`, `served-source-checks.json`,
  `anonymous-login-smoke.jpg`, `fixture-shutdown.json`
- `candidate/docs/SCANNER_EARLY_CANDLES_2026_10_31.md`
- `candidate/docs/SMART_CHART_STUDY_LINES_2026_10_31.md`
- `candidate/docs/validation/{scanner-early-candles,chart-study-lines}-20261031/`
  contain both compressed and restored receipts. All 93 manifest entries'
  original and archive hashes verified, including upstream failed experiments.

Prior workspace receipts remain under
`generated-artifacts/arx-dmi-shortcuts-validation/`,
`generated-artifacts/arx-pending-engine-validation/` and earlier report folders.

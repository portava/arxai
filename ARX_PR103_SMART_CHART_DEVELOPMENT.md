# PR103 Smart Chart — selective development integration

## Provenance and scope

- Verified upstream PR: `https://github.com/portava/arxai/pull/103`.
- Source branch: `codex/chart-round3-acceptance-20261028`.
- Exact source head: `9d3b3ea8214c25294ca851ab9a0e6c54272b4f07`.
- Previously imported source/base:
  `273103076237a9bcc9bfbf0222b03e19e6211d5b`.
- Pre-integration development checkpoint:
  `bb048a6206177624985f5082a2560958247c5db5`.
- Recoverable backup reference: `codex/backup-before-pr103-20261031`.
- Development integration branch:
  `codex/pr103-smart-chart-development-20261031`.
- The final commit containing this report is the resulting development
  checkpoint; its exact hash is supplied in the delivery response.

This is a **selective feature import**, not a checkout/reset to the PR branch or
a claim that the entire PR has been imported. The source delta was reconciled
against the last imported upstream source, not unrelated workspace ancestry.
The selected files had no overlapping local edits.

Imported scope: 98 upstream paths comprising the shared chart, Scanner surface,
chart workbench/replay/mini-chart dependencies, fixed-duration interval handling,
native replacements for old embedded-chart pages, chart-related symbol handling,
the candlestick catalogue dependency, matching tests and JSON fixtures, and chart
acceptance scripts. The safety-header dependency removes the obsolete assumption
that merely loading an external chart library proves a live feed.

Excluded scope: backend, mission/terminal-result changes, database/schema changes,
unrelated Scanner freshness changes, production/deployment adapters, package
versions/lockfile changes, and other unrelated upstream work. No other branches
or uncommitted upstream work were combined.

## Implemented chart surface

- Market Scanner's `ScannerChartPanel` renders shared `ARXNativeChart` rather than
  constructing the older independent candlestick chart.
- Zoom in/out, directional pan and pan mode.
- Fixed-duration intervals:
  `M1 M2 M3 M4 M5 M6 M10 M12 M15 M20 M30 H1 H2 H3 H4 H6 H8 H12 D1`.
  Weekly/monthly requests retain explicit limitations rather than being silently
  treated as fixed-duration bars.
- Studies, named browser-local templates and user text-note tools.
- Feed/evidence warnings and disclosures above the plot.
- Old external-widget chart pages use the native shared chart.
- Required linked plain-text Lightweight Charts credit is retained; graphic
  library attribution logos are disabled.

## Preservation and safety boundary

No auth route/hook, sign-in/sign-out logic, API startup code, database/schema source,
credential, production adapter, artifact registration or broker/job configuration
was changed. Existing preview safe-start and disabled execution settings remain.
No migrations, schema pushes, seed scripts, credential changes, worker enablement,
emails, authenticated broker tests or live/demo orders were performed.

No GitHub merge/push, main update, publication or republish was performed.
Only the development frontend workflow was restarted, after the corrected checks
passed. The API and mockup workflows were not restarted.

Unit/type/build validation used credential-free subprocess environments and
synthetic/offline configuration. Those tests did not target the application
database. No direct database operations or fixtures were performed. The browser
pass used normal authentication and encountered an existing automatic alert-scan
request, described below; zero ordinary application writes are not certified.

## Validation results

| Check | Actual result |
| --- | --- |
| Initial complete frontend Vitest run | 165 files passed, 2 failed; **2,400 cases passed, 2 failed, 9 skipped** |
| Corrected affected frontend rerun | **2 files, 8 cases passed**; included both previously failing cases |
| Initial candlestick catalogue run | **398 passed, 2 failed** due to missing matching coverage JSON |
| Catalogue rerun after importing matching JSON | **400/400 passed**, no skips |
| Disclosure geometry/state Node checks | **6/6 passed**, no skips |
| Root library/API/dashboard/sandbox/scripts typecheck | **Passed** |
| Final frontend typecheck after dependency completion | **Passed** |
| Initial build invocation | Failed before compilation because isolated harness omitted required `PORT` |
| Corrected final frontend production build | **Passed**; existing large-chunk warning retained |
| Whitespace check | Passed |

The initial failures are retained in the logs. They were resolved by importing
the required same-head coverage/scope JSON and safety-header changes, and by
supplying the build harness's required non-secret `PORT`/`BASE_PATH`. No
assertions, checks, feed-integrity gates or performance thresholds were relaxed.

The complete frontend suite was **not rerun wholesale** after those dependency
imports; the two affected files passed their focused rerun. Do not describe the
initial full run as entirely green or add overlapping rerun counts as unique
coverage. Source files not touched by the corrections retain their prior result.

## Served frontend versus build artifact

After the frontend restart, shared-preview HTTP reads confirmed:

- Root HTML serves Vite development modules, not the production `dist` directory.
- The served Scanner panel imports `ARXNativeChart` and no longer constructs its
  own candlestick series.
- The served shared chart imports the named Templates panel.

The production build was validated separately. Passing a build alone was not
used as proof that the preview served the new chart.

## Browser verification

The testing agent returned **success overall with non-blocking findings** after
checking the actual served application, not an isolated chart sandbox:

| Actual browser check | Result |
| --- | --- |
| Scanner desktop, 1440 × 1000 | Shared `ARX SMART CHART` displayed with populated M15 candles |
| Scanner mobile, 390 × 844 | Same shared chart rendered; Tools disclosure exposed advanced controls |
| Real data | Public Deriv V75 candles, clean/live as reported by the app; no browser response injection |
| Named browser template | Save, change chart style, apply, reload/persistence, and delete passed |
| Studies | Add SMA (20), verify active, and remove passed |
| User text note | Create, edit and delete passed; mobile input/instructions reached and canceled |
| Warning/feed disclosure | Available above plot; identified synthetic-market data and broker-price/fill caveat |
| Plain-text credit/no graphic logo | Passed on Scanner, `/live-chart` and `/live-manual`; zero external widget iframes/logo images found |
| Legacy embeds | `/live-chart` and `/live-manual` rendered the native chart; tickets were not exercised |
| Expanded interval controls | Requested fixed-duration choices present; W1/MN1 disabled with explicit limitations |
| M2 real-data plot | **Not verified**: stayed at waiting/loading; M15 restored populated candles |
| Zoom/pan | Controls exercised without UI errors; actual range change **not conclusively browser-verified** |
| Sign-out | App Sign out returned to `/login`; identity endpoint then returned expected 401 |

The adapter's deterministic unit tests separately verified viewport-range
changes for zoom/pan without rewriting candle data; these do not replace the
unverified visual measurement in the real browser.

The first browser attempt was blocked because its notebook did not inherit
workspace Secrets. Normal login and authenticated identity were then verified
through the approved workspace environment (both HTTP 200). A private temporary
server-issued QA session initialized the browser without printing credentials or
cookies. **Credential-form typing was not browser-tested.** The tester signed out
that session and closed the secondary context. Temporary session material was
removed after verification.

### Observations and limits

- Mobile had no horizontal page overflow: measured document width 375px against
  a 390px viewport. Representative controls were 32px high. The floating
  assistant overlapped the Study panel's lower-right scrollbar margin by 22px,
  not the measured first add-study control.
- Browser logs showed onboarding-dialog hydration errors (`div` nested in `p`),
  repeated unidentified resource 404s on `/live-manual`, and slow successful
  market-data/heat GETs. Charts still rendered. Their pre-integration baseline
  status was not independently established.
- The page automatically made
  `POST /api/me/chart/ai-alerts/scan` (HTTP 200). This same automatic call existed
  before this import. The agent did not click Scan/Trade or call it manually.
  Source inspection shows the endpoint can persist per-user chart-alert state
  and deduped notifications; actual persistence was not queried or undone.
  **Therefore this report does not assert zero application-database writes
  during page loading.** No further browser actions were requested after this
  was reported. No schema migration, fixture insertion, account/credential
  change, broker action or order was performed.
- No annotation create/delete API was used; templates and text notes were
  exercised through browser-local storage. Note persistence across a browser
  reload was not separately asserted; template persistence was.
- Other native embed routes were source/unit-checked, not all browser-visited.
- No performance benchmark, broker-price/fill validation, live/demo trading
  acceptance, or complete application acceptance is claimed.

Screenshot references in the retained browser report:
desktop `heaonr`, mobile `ah5qcb`, feed disclosure `fm3haj`, local template
`p1tyx6`, local note `oq93s0`, mobile Study panel `0zcaxx`, final sign-out
`p72y33`.

## Evidence

Detailed import receipt, command logs/results, preservation audit and served
module checks are retained under:

`generated-artifacts/arx-pr103-validation/`

This directory is excluded from Git/deployment. Private authentication material
is not part of the report or retained validation evidence.

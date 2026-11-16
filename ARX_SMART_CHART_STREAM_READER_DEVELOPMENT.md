# Development Smart Chart stream-reader follow-up

## Terminal outcome and saved source

**Scoped integration and combined-source validation PASS. Authenticated and
real-provider acceptance remain UNVERIFIED. No parity/launch-ready approval.**

- Branch: `codex/pr103-smart-chart-development-20261031`.
- Recovery checkpoint: `08eace9a35b37ac98b7580b2bb30a6a991ee7d9f`.
- Recovery reference: `codex/backup-before-stream-reader-20261031`.
- Application-source checkpoint: `06f3d524222f81235cb7ff24c4fc75c4ba2a138c`.
- Frozen upstream backup: `c0bfe8daa10a097933532c5011eb550df37c601d`.
- Checked upstream application: `be4b22d1a4ae608f96d1ee4c5506ec5d602a9c26`.
- Upstream branch: `codex/chart-stream-reader-20261031`.
- Application delta base: `256aff05cfeda351927c8485044210ef59c90d47`.
- Final documentation/checkpoint SHA is recorded in the delivery and ignored
  `checkpoint-receipt.json`, avoiding a self-referential report hash.

Starting branch/HEAD matched the authorized checkpoint and the working tree was
clean. No staged changes, Git locks or concurrent source edits were observed.
The recovery reference was saved before application edits. No remote branch was
reset, pushed or merged; no full tree was imported.

## Reviewed scope and preservation

Read the frozen stream-reader validation report before editing. Compared the
checked application to the already imported 256aff05 source, excluding intervening
documentation-only evidence. Four non-documentation paths only:

1. `artifacts/trading-dashboard/src/lib/chart-engine/lightweightChartsAdapter.ts`
2. `artifacts/trading-dashboard/src/lib/chart-engine/lightweightChartsAdapter.performance.test.ts`
3. `scripts/scanner-qa/shared-chart-stream-reader.js`
4. `scripts/scanner-qa/shared-chart-stream-reader-check.js`

Both existing files matched the expected base exactly; both new scripts were
absent. All four candidate blobs match the checked application and frozen backup.
The preservation audit verifies those exact blobs/hashes and no unexpected
application changes. All seven preceding cockpit files remain unchanged, as do
authentication/sign-out, startup/API/safe-start launchers, Truth and finality
gates, dependencies/lockfiles/manifests/test commands, schemas/migrations, worker
settings and execution/order/risk gates. No overlap needed reconciliation.

The runtime fix is one call to the existing frame-coalesced viewport queue after
an accepted streamed update. It notifies the embedded reader even if the range
does not move. It does not mark streamed data final/closed. Regressions cover
100-revision coalescing, rejected data, unsubscribe/destruction, actual reader
withdrawal/recovery and exclusion of forming/unconfirmed streamed tips.

Outside the four imported source/test/tooling paths, tracked changes are this
report and two agent-memory documentation files recording import-tool limits.
No additional application behavior was introduced.

## Actual combined-workspace checks

These are local results, not the quoted upstream 2,541 passes.

| Check | Actual result |
|---|---|
| Full frontend | **2,536 passed / 11 skipped / 0 failed**, 2,547 total |
| Frontend files | **174 passed / 1 skipped**, 175 total |
| Adapter regressions | **52/52 passed**, included in full run |
| Reader regressions | **21/21 passed**, included in full run |
| Reader-cache regressions | **13/13 passed**, included in full run |
| Root libraries/API/frontend/scripts typecheck | PASS, exit 0 |
| API production build | PASS, exit 0 |
| Frontend production build | PASS, exit 0 |
| Server scheduling/route/listener tests | **13 passed / 0 skipped / 0 failed** |
| Navigation/disclosure tooling | **15 passed / 0 skipped / 0 failed** |
| Freshness-policy fixtures | PASS, including 8 negative display-policy fixtures |
| Guards | **87/87 passed** |
| Master bridge syntax bindings | **7 assertions passed** |
| Imported browser scripts and fixture builder syntax | PASS |
| Isolated actual-dashboard fixture build | PASS |
| Exact-source preservation and diff checks | PASS |

The 86 adapter/reader/cache tests are included in the 2,536 total, not added
again or rerun separately. All ten harness commands exited zero. No application
source was changed after these checks and no suite was rerun.

Elapsed commands: frontend 114.1 s; root typecheck 55.0 s; API build 1.7 s;
frontend build 15.5 s; server tests 1.2 s; tooling 0.2 s; freshness fixtures
1.1 s; guards 23.2 s; imported-script syntax 0.1 s; fixture build 11.0 s.
The initial two check lanes ran in parallel; all builds finished before the
browser observations.

The credential-free harness uses synthetic unavailable loopback DB/AI targets,
disabled execution/settlement/public-data/auth test settings and an external
socket guard. No actual account/database fixture or broker test was used.

## Offline actual-Scanner browser check

One bounded pass over the actual combined dashboard App/routes/Scanner/adapter/
reader. The generic upstream fixture builder was absent locally, so six reviewed
support files were retained only under ignored `fixture/` evidence. Only import/
repo/output paths were adapted. The builder imports the real application and
existing QA witness, with no component, hook or authentication implementation
replacement. Its isolated Vite configuration is **not** the deployable bundle.

- Immutable fixture ID: `8a6ad5b3b1bec0c4`.
- Metadata and executing entry ID matched.
- Source: `06f3d524222f81235cb7ff24c4fc75c4ba2a138c`, clean status,
  `sourceUnchanged: true`; production runtime and asset hashes checked.
- Fresh isolated browser context, service workers blocked.
- All external traffic and API writes denied before the first navigation.
- Constructed source-shaped candle responses and stream frames only. Mocked
  `/api/me` was a synthetic fixture response, not a real login or account.
- Saved browser arrow-function script ran unchanged against the loopback static
  server; it never contacted the development API.

All six transitions passed: closes 100.5, 100, 100.6, 100, 100.7, 100 produced
unavailable, ready, unavailable, ready, unavailable, ready. Full before/after
canonical arrays (200 bars) and real display arrays (200 bars) matched exactly;
chart identity and confirmed as-of boundary were unchanged.

| Constructed close | Expected | DOM observation ms | Two-frame opportunity ms |
|---|---|---:|---:|
| 100.5 | unavailable | 11.2 | 37.9 |
| 100 | ready | 18.3 | 45.0 |
| 100.6 | unavailable | 18.8 | 46.1 |
| 100 | ready | 19.8 | 46.2 |
| 100.7 | unavailable | 18.8 | 49.8 |
| 100 | ready | 18.0 | 46.3 |

All raw observations/outliers remain in the saved result. These are six small
synthetic stream-to-DOM observations, not hardware paint, heavy-history 60 fps,
a latency percentile, broker speed or first-navigation acceptance.

Diagnostics retained: **0 page exceptions, 36 console error entries** from
intercepted unavailable/denied reads; unknown read paths remain in the full
network log. **Two automatic POST attempts** (`/api/me/chart/ai-alerts/scan`,
`/api/me/scalp/focus`) received local 503 responses and never reached a server.
No external requests were attempted; no Scan/Analyze/order control was clicked.
Zero page exceptions does not mean an error-free console.

Recovered-reader screenshot `5xxjrb` was inspected. It retains stored/
not-live-confirmed, stale and trading-blocked labels plus plain-text library
credit. The tool supplied an image ID, not workspace image bytes; the evidence
file records that limitation rather than inventing a screenshot path.
The owned fixture browser context was closed and its static server stopped.

## Development preview checks

Refreshed only the existing frontend workflow once after validation; Vite started
cleanly. API, job settings, mockup and validation workflows were not restarted or
reconfigured. Health/readiness GETs returned HTTP 200. The served transformed
adapter contains the executable sequence `refreshLater` -> `queueViewportUpdate`
-> `queueLegendUpdate`.

An anonymous desktop `/login` screenshot rendered the sign-in form; its browser
logged the expected unauthenticated 401. No login was attempted and no owner
credentials, sessions, account data or saved preferences were changed.
The ordinary preview serves development Vite source, not the offline fixture.

## Failures, skips and limits

- No frontend/server/tooling/type/build/guard test failed. Eleven frontend skips
  remain: nine feed-badge cases and two opt-in reader benchmarks in one file.
- The browser runner's first setup-tool attempt used unsupported synchronous
  filesystem access; it was corrected before executing the single browser
  journey. The saved result retains this setup error. No browser assertion was
  relaxed and no second broad pass was run.
- A served-source helper first searched for a comment stripped by Vite and
  failed its marker assertion. The corrected executable-sequence probe passed
  with no source change or test rerun; both are described in `runtime-checks.json`.
- Initial remote inspection exceeded persistent-notebook memory and reset the
  notebook. Required scoped metadata was fetched again; no current validation or
  browser job was active then. No workspace source/evidence was lost.
- Existing frontend bundle-size/API size advisories, 28 React act-warning
  occurrences, four zero-size chart warnings and hydration/DOM-nesting text
  remain. Runtime provider access/rate limits and slow timing GET warnings remain;
  they are not new rendering or provider measurements.
- Upstream's pre-fix 2-fail/50-pass tests, baseline browser withdrawal failure,
  intermediate renderer/timer attempts and missing generated-declaration
  typecheck failure were reviewed as provenance only, not reproduced locally.

Authenticated/real-provider active-reader acceptance was not attempted while the
owner is away. No credentials were requested. No full root CI, database/native
terminal/broker integration, new mobile/touch acceptance, heavy-history benchmark
or competitive comparison was performed.

Earlier immediate-first-click acceptance remains **FAILED/incomplete**; no new
initial-navigation/correct-candle/completed-analysis measurement occurred.
Historical warm/invalid timing records remain preserved, as do the earlier M2
no-data, zoom/pan, mobile Study overlap, hydration, legacy-page 404 and historical
alert-POST limitations. This isolated fixture's write denial does not prove
zero historical or global writes in other sessions.

No publishing/deployment, main merge, existing-database writes/migrations,
credentials/account changes, worker/trading activation, orders, emails or
live/demo broker tests were performed. No parity or launch-ready claim.

## Evidence paths

Directory: `generated-artifacts/arx-stream-reader-validation/` (ignored by Git
and deployment).

- `import-manifest.json`, `preservation.json`, `audit.py`.
- `upstream-SMART_CHART_STREAM_READER_2026_10_31.md`, `upstream-manifest.json`,
  `upstream-browser-run.js`, `upstream-checks.py`.
- `base/`, `candidate/`: only the scoped files, not a replacement application.
- `run.py`, `offline.cjs`, `validation-summary.json`.
- `stream-frontend-results.json`, `stream-frontend-0.log`.
- `stream-checks-results.json`, `stream-checks-{0..7}.log`.
- `stream-fixture-results.json`, `stream-fixture-0.log`.
- `fixture/`, `fixture-build-id.txt`, `builds/8a6ad5b3b1bec0c4/`.
- `browser-brief.md`, `browser-run-result.json`,
  `browser-run-fixture-metadata.json`, `browser-run-network-diagnostics.json`,
  `browser-run-evidence.json`.
- `anonymous-login.jpg`, `runtime-checks.json`.
- `checkpoint-receipt.json`, `evidence-manifest.json`.

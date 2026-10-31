# Development cockpit reliability follow-up

## Scope, provenance and recovery

- Integration branch: `codex/pr103-smart-chart-development-20261031`.
- Recovery checkpoint: `a8a7fedc7afcb140997c885570b0efdc107c1b44`.
- Recovery reference: `codex/backup-before-cockpit-truth-20261031`.
- Frozen upstream backup: `6db9fa1f91327200e14493f876b81841b5cf5ad1`.
- Checked application: `256aff05cfeda351927c8485044210ef59c90d47`.
- Upstream branch: `codex/cockpit-unavailable-states-20261031`.
- Delta base: `861c56f913e6424cfc4e26eefaa8f09c7dc0aca1`.
- Resulting application-source checkpoint:
  `83ebc69e38c1b53ddd7336f99663c79e9a743212`.
- Exact resulting source/final checkpoints are recorded below and in the ignored
  `checkpoint-receipt.json`; the final delivery identifies the report commit.

The starting branch/HEAD matched the completed checkpoint and the working tree
was clean. No staged changes or Git locks were found; no concurrent integration
changes were observed. This describes the inspected workspace, not other
external actors. The recovery reference was saved before application edits.

Reviewed the upstream account-truth, partial-refresh and unavailable-state
reports and the partial-refresh selective-source manifest before importing.
Seven paths only: five existing frontend source/test files and two new component
regression files. Every existing path matched the frozen upstream delta base,
and the two new files were absent, so no overlapping local edits were replaced.
Candidate content matched all seven manifest SHA-256 values; the application
and backup Git blobs matched for each path.

The preservation audit verifies seven exact candidate files and no unexpected
source changes. Every tracked source path outside this selection remains
identical to the recovery checkpoint. Preserved: local authentication/sign-out,
API app/index startup and safe-start launchers, Truth fixtures/tests outside the
selection, all manifests/dependencies/lockfiles/CI and test-command changes,
previous Scanner/chart/navigation work, schemas/migrations, worker settings and
execution/order/risk gates. No backend or dependency change was required.

## Imported changes and boundaries

- Calendar, alerts, performance and timing cards distinguish unavailable/error/
  malformed responses from response-scoped successful empty results.
- Timing excludes missing, estimated, malformed, unrequested and duplicate/
  conflicting rows; errors withdraw cached candidates. Partial coverage and
  reported generation/response-receipt times stay explicit. These times do not
  prove quote freshness or add a new entry/expiry policy.
- Account figures display unknown as dashes, preserve genuine zeroes and losses,
  do not infer Active from live mode, and label retained figures last-known.
- Position cards distinguish unavailable, incomplete and last-known evidence;
  a funds-only response is not a complete position snapshot.
- Successful partial funds responses clear null/missing/malformed amounts rather
  than refreshing old values. Allocation/bridge flags require boolean true.
  Explicit null canonical funds clear previous evidence; omitted canonical
  blocks may retain only same-mode stale evidence. Leaving LIVE_SHARED clears
  those amounts. Request failure retains previous evidence with its original age.
- Open Trades honors unknown-count metadata and shows a dash, not a zero
  placeholder. Other Open Trades totals, exposure and empty-list guidance remain
  outside this follow-up's acceptance.
- No order/reservation/audit-release behavior, permission or trading gate changed.

## Combined-workspace validation

| Check | Actual result on this workspace |
|---|---|
| Full frontend | **2,533 passed / 11 skipped / 0 failed**, 2,544 total |
| Frontend files | **174 passed / 1 skipped**, 175 total |
| Imported account-truth component regressions | **12/12 passed** within the full run |
| Imported unavailable/timing-state regressions | **33/33 passed** within the full run |
| Account snapshot hook regressions | **53/53 passed** within the full run |
| Root library/API/frontend/scripts typecheck | PASS, exit 0 |
| API production build | PASS, exit 0 |
| Frontend production build | PASS, exit 0 |
| Server scheduling/route/listener regressions | **13 passed / 0 skipped / 0 failed** |
| Navigation/disclosure tooling | **15 passed / 0 skipped / 0 failed** |
| Shared freshness-policy fixtures | PASS, including eight negative display-policy fixtures |
| Guards | **87/87 passed** |
| Master bridge syntax bindings | **7 assertions passed** |
| Selective-source preservation and diff checks | PASS |

The three relevant frontend files total **98 passing tests**, already included
in the 2,533 total, not additional tests or separate reruns. Actual local counts
differ from upstream's 2,538 passes; the frozen local authentication/Truth and
other source differences were preserved rather than overwritten to match a
quoted count. All eight validation commands exited zero; none was rerun.

Elapsed command times: frontend 129.1 s; typecheck 63.9 s; API build 2.4 s;
frontend build 21.8 s; server regressions 1.7 s; navigation tools 0.2 s;
freshness fixtures 1.7 s; guards 26.4 s. The two validation lanes ran in parallel.

The harness allows only basic process environment, uses synthetic unavailable
loopback DB/AI targets, excludes actual credentials and blocks external sockets.
Execution, settlement, test auth and public market-provider test settings are
disabled. No existing-database fixtures, provider calls, orders or broker tests
are part of these runs.

The full frontend run includes the imported component/account/partial-refresh
regressions; its relevant per-file results are recorded separately below.
Upstream's 2,538 passes and mocked-browser results are not local results.

## Runtime and rendered acceptance

Refreshed only `artifacts/trading-dashboard: web`, once after checks passed.
Vite started cleanly (ready in 452 ms). The API, mockup and validation workflows
were not restarted or reconfigured. Source remains on the integration branch;
no whole-tree replacement, PR merge or push was performed.

Read-only development health and readiness endpoints both returned HTTP 200.
Actual served Vite modules also returned HTTP 200 and contained the new
unavailable/incomplete/last-known/status-unknown card text, timing partial
coverage, strict allocation flags, amount-clearing and unknown-count code.
These checks establish served source, not authenticated DOM behavior.
Production build artifacts were validated, not published or used as a claimed
production deployment.

One anonymous desktop `/login` screenshot rendered the sign-in form normally.
The browser reported an expected unauthenticated 401 resource response; Vite
connected. No fields were entered or buttons clicked. This is not a sign-in
flow test, does not verify funds or trading, and does not retrospectively erase
the earlier loading-skeleton discrepancy.

Authenticated real-user acceptance remains unavailable while the owner is away.
No credentials were requested/read, and no account, authenticated session, onboarding or
preferences were changed to bypass that limit. No authenticated browser test is
being claimed. The upstream mocked production-fixture browser evidence was
reviewed only, not rerun or presented as this workspace's rendering acceptance.
No new first-click timing or competitor comparison was performed.

## Failures, skips and retained limitations

No new automated-check failures. Eleven frontend skips: nine existing feed-badge
cases and two opt-in reader-performance benchmarks in the one skipped file.
No full root CI, existing-database integration, native-terminal/broker/live/demo,
real authenticated desktop/mobile, new mocked-browser fixture, first-click timing
or release/launch test was run.

Warnings remain: frontend chunks above 500 kB, API bundle-size advisory,
28 React act-warning occurrences, four chart zero-size warnings and hydration/
DOM-nesting warning text in the frontend test output. Runtime logs continue to
show provider access/rate-limit warnings and slow timing reads; no new provider
or funds latency measurement is claimed.

The shared log collector also surfaced a separate deployment log stream with
monitor/outcome query errors at 18:33, before this update's checks. Those are
not failures from these development tests. Production was not investigated,
restarted, migrated or otherwise changed, and no production-health claim is made.

Upstream historical evidence remains separate from local checks: the original
unavailable-state regressions failed 15/16 before correction; account regressions
failed 9/12; 12 of 13 new partial-refresh hook cases failed before correction.
Their reports retain native-dependency startup, helper/omitted-block expectation
and offline fixture direct-route browser failures, plus corrected runs. Those
are reviewed provenance, not failures or passes from this workspace.

Prior immediate-first-click acceptance remains **FAILED/incomplete**. Six
historical warm observations and two invalid corrections are retained in
`ARX_SCANNER_NAVIGATION_SPEED_UPDATE.md` and its evidence directory. Upstream
synthetic approximately 116 ms medians and 0/10 meeting 100 ms do not establish
this preview's first correct candles, physical paint or completed analysis.

Earlier M2 no-data, inconclusive zoom/pan range, mobile Study-panel overlap,
hydration warnings, legacy `/live-manual` 404s and historical ordinary alert POST
limitations remain open. This seven-file update does not clear them.

Other limits: whole-page unknown-data audits, other Open Trades totals/exposure,
currency/account-mode/permission-card assertions and complete SSE/canonical
runtime schema validation remain incomplete. No actual provider/terminal
freshness, broker latency, competitor parity or launch readiness is certified.
This improves the scoped display/transport behavior, not the complete product.

No deployment/publishing, main merge, migrations/forced schema pushes, direct
existing-database writes, credential changes, worker enablement, trading/orders,
broker/live/demo tests or emails were performed.

## Evidence

Retained locally, ignored from Git and deployment:
`generated-artifacts/arx-cockpit-reliability-validation/`.

- `import-manifest.json`: exact base, backup, source, seven Git blobs and hashes.
- `upstream-development-source-manifest.json`.
- `upstream-COCKPIT_ACCOUNT_TRUTH_2026_10_31.md`,
  `upstream-COCKPIT_PARTIAL_REFRESH_2026_10_31.md`,
  `upstream-COCKPIT_UNAVAILABLE_STATES_2026_10_31.md`.
- `base/` and `candidate/`: reviewed scoped source, no full app replacement.
- `audit.py`, `preservation.json`: preservation assertions.
- `run.py`, `offline.cjs`: credential-free validation harness.
- `relevant-frontend-results.json`: the three included regression file results.
- `reliability-frontend-results.json`, `reliability-frontend-0.log`.
- `reliability-checks-results.json`, `reliability-checks-{0..6}.log`.
- `runtime-checks.json`, `checkpoint-receipt.json`, `evidence-manifest.json`.
- `anonymous-login.jpg`: anonymous desktop rendering only, not authenticated acceptance.

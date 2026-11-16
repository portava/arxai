# ARX combined integration — development checkpoint

> Subsequent preview restoration: the API now runs with an explicit
> development-only safe-start setting that pauses background jobs and core-agent
> seeding. Authentication does not depend on the new feature tables. No migration
> or password change was performed. The login endpoint now returns the expected
> JSON 401 for a synthetic invalid account, rather than a proxy 502; the public
> login page also renders normally. The original validation results and feature
> schema blockers below remain unchanged. The runtime-status section below
> describes the initial integration checkpoint, before this restoration.

Recorded: 2026-10-27. **Source applied; validation is not fully green. Not approved for publication or existing-database rollout.**

## Source and checkpoint

- Repository: `https://github.com/portava/arxai`
- Selected combined source: `codex/platform-evidence-integration`
- Exact imported commit: `273103076237a9bcc9bfbf0222b03e19e6211d5b`
- Actual prior imported source, verified from the existing sync receipt:
  `2f5a961f5afd0e65d776da229c1fcae474de6e58`
- Pre-update workspace checkpoint:
  `0c647e254911d809063fa2ff0ab077197d1e3a8e`
- Backup reference: `codex/backup-before-platform-evidence-20261027`
- Result branch: `codex/platform-evidence-development-20261027`
- The development commit containing this report is the resulting checkpoint.
  Its hash is reported in the delivery message; it cannot be embedded in itself.

Only the exact combined source was fetched/imported. No other branches were
merged, no held performance-experiment branches were imported, and no
uncommitted upstream terminal-result work was copied. No GitHub push, main merge,
publication, republish or production change was performed.

## Reconciliation and preserved work

The source delta contains 443 files. A three-way Git tree reconciliation mapped
the prior and requested upstream source roots under `arxai/`, leaving the outer
Replit repository intact. The prior nested application had 34 differences from
its recorded source. Five files overlapped the incoming delta; three package
manifests required explicit conflict resolution.

The requested package scripts already contain all the previous local script
additions. They were retained from the combined source, with the local Express
`^5.3.0` firewall adjustment restored. The existing Orval adjustment and nested
lockfile are unchanged. No dependencies were installed.

The preservation audit found **no unexpected changes to independent local
differences**. Thirty-two paths still differ from the requested source, including
the local reports and:

- Password-reset token/log protections in the auth route.
- Private-query cancellation/sign-out fixes in the current-user hook.
- Local test-isolation, risk-fixture, security and governance fixes.
- Auth-session browser QA and its safe integration-runner wiring.
- Nested Vite/preview routing adjustments and the removed duplicate registration.
- Express/Orval and dependency-lockfile firewall adjustments.

The entire outer artifact scaffold, development/production launch adapters,
preview admin setup, existing Secrets and private backup directories were left
unchanged. Development public read-only Deriv data remains enabled in its
launcher; authenticated broker credentials remain excluded and live broker
execution remains explicitly disabled. No Algo Trading control was changed.

## Validation environment

Commands used credential-free allowlisted subprocess environments. The top-level
Node test/build processes used a loopback/local-socket connection guard; dedicated
PostgreSQL runners constructed their own clean environments and local clusters.
The browser fixtures blocked requests outside their two local synthetic-data
origins. No application Secrets were read, printed, changed or passed to validation.

The eight PostgreSQL test runners created their own Unix-socket-only disposable
clusters, exercised their fixture schemas, then stopped and removed those
clusters. Their test migrations did **not** target an existing application
database. No schema/data changes were made to development or production app
databases, and the normal API workflow was stopped before source import.

The MT5 Python checks were offline fake-terminal/core contract tests, not
terminal connections or demo-order tests. No live/demo orders, authenticated
broker connections or emails were sent.

## Results

| Check | Result |
| --- | --- |
| Full frontend Vitest suite | **155 files passed; 1,756 tests passed, 9 skipped** |
| Root typecheck | **Passed**: composite libraries and API, dashboard, sandbox, scripts leaf checks |
| Source guards | **87/87 passed**, plus 7 master-bridge syntax fixture assertions |
| API build | **Passed** |
| Dashboard production build | **Passed**; existing large-chunk warning remains |
| Affected backend validation commands | **32/35 passed initially**; see failures below |
| Eight disposable PostgreSQL suites | **All passed**: 294 passing cases, 11 skipped |
| Result-receipt command with explicit Node module-mock flag | **35/35 tests passed** |
| Outer preview launcher safety test | **Passed** |
| Committed offline browser acceptance scripts | **2/7 passed; 5 failed**, detailed below |
| Whitespace/conflict-marker checks | **Passed** |
| Public login screenshot | Frontend renders; expected API 502 while API is paused |

The backend checks include affected scanner/concurrency, Truth, catalogue,
research, target-management, lifecycle, result-evidence and accounting suites.
Some package commands overlap test cases; their counts must not be summed as
unique coverage. This is not a full root CI/integration pass and does not
reproduce or inherit the ancestor's previously reported validation totals.

### Retained backend failures

1. `pnpm --filter @workspace/api-server run test`
   runs legacy HTTP/database suites, not an isolated offline aggregate.
   It failed because no fixture API was running and the deliberately unusable
   database URL refused connections. It was not pointed at the shared app
   database to manufacture a pass.
2. `test:execution-epistemology` omits
   `--experimental-test-module-mocks`. Its imported settlement-worker test
   failed with `TypeError: mock.module is not a function` on Node 24.22.1.
   The exact same files passed all 35 tests with that flag supplied explicitly.
   The source package command and original failing evidence were retained.
3. `test:fast-unit` reported two handshake enforcement assertion failures:
   privileged-user posture and authenticated-user non-admin actions were
   blocked while their database lookups were unavailable. This command is not
   fully database-independent. Those assertions/security gates were not changed,
   and no successful existing-database rerun is claimed.

### Retained browser failures

Fresh Chromium contexts ran the committed acceptance functions against isolated
real-component fixtures, with synthetic bars and no app/broker API access.
Scanner script ports were mapped to the single scanner fixture port, and
artifact paths were redirected to the temporary validation directory. Assertions,
timing budgets and application behavior were unchanged.

| Script | Result |
| --- | --- |
| `scripts/chart-qa/acceptance.js` | Failed: disabled Fit history control timed out |
| `scripts/chart-qa/workbench-acceptance.js` | Failed: chart initialization wait timed out |
| `scripts/chart-qa/studies-acceptance.js` | Failed: chart initialization wait timed out |
| `scripts/chart-qa/layout-acceptance.js` | Failed: chart control timed out |
| `scripts/scanner-qa/acceptance.js` | Passed |
| `scripts/scanner-qa/responsiveness.js` | Failed: click-feedback p95 exceeded the 100 ms budget |
| `scripts/scanner-qa/saved-screens-acceptance.js` | Passed |

The committed chart fixture's `useGetChartCandles` response lacks top-level
`symbol` and `timeframe`. The updated real chart now requires those identity
fields before accepting candles; the fixture therefore supplies no accepted
series. This is a fixture-contract defect, not evidence that the authenticated
chart works or fails with a valid real response. It was not bypassed by weakening
the chart's identity checks.

The scanner timing failure applies to this fixture/container run, not proven
production network latency. No held performance experiments were imported to
address it and the threshold was not relaxed.

## Schema blocker and runtime status

New schema source and migrations are preserved:

- `arxai/lib/db/src/schema/researchExperiments.ts`
- `arxai/lib/db/src/schema/resultSettlementJobs.ts`
- `arxai/lib/db/migrations/2026-10-26_research_experiments_v1.sql`
- `arxai/lib/db/migrations/2026-10-26_result_settlement_outbox.sql`

The result-settlement migration explicitly requires its table before this
application release; research persistence also requires its new table/functions.
**Neither migration was applied to an existing app database.** No backfill or
automatic schema push was run there.

The dashboard managed workflow was restarted and is serving the updated frontend.
The API managed workflow remains intentionally **stopped** to avoid startup writes
or running schema-dependent code against the existing database. Consequently,
preview API calls and sign-in currently receive 502 and authenticated application
flows were not runtime-verified. The unrelated mockup workflow was left alone.

Before a complete runtime acceptance, an authorized schema rollout must be
reviewed, the validation harness/browser failures addressed, and the new API
started and checked against an explicitly approved compatible database.

## Evidence location

Detailed command results, initial failure logs, browser outcomes, source
preservation audit and SHA-256 log digests are retained in:

`generated-artifacts/arx-platform-validation/`

This generated evidence directory is excluded from Git and deployment output.
The report itself is committed. No validation failure has been suppressed or
reclassified as a pass.

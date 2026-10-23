# ARX AI imported baseline

Verified on 2026-10-23. **Imported faithfully, but not a fully green or publish-ready baseline.**

## 1. Repository and branch

- Canonical repository: https://github.com/portava/arxai
- Selected source: GitHub's default branch, `main`.
- Source commit: `d10810713f13c022874ee0ee6adcade190243381`.
- Source lives in `arxai/`; the outer Replit scaffold remains separate.
- No branch switch, merge, GitHub commit, or push was performed.
- A similarly named repository was not used.

The default branch was selected deliberately rather than silently substituting an experimental branch. At inspection there were no open pull requests. The fetched repository has 85 remote branch refs, with 54 branches containing commits outside `main`. In particular, `phase6/guided-mode` at `673270896b031950fee749b918abe0ad4d1e78b7` is 222 commits ahead of `main`. It is preserved for review, not selected as the baseline. This report does not assert that `main` includes those later changes.

## 2. History and checkpoint

The original clone included full Git history. After workspace import/registration, the nested `.git` metadata was no longer present and the workspace used Replit's checkpoint repository.

To retain provenance without replacing that repository, GitHub was added as the separate `arxai-upstream` remote and its full history and branch refs were fetched. Replit's workspace branch was not replaced. The upstream repository layout is rooted differently from this workspace: **do not push workspace `main` directly to GitHub's `main`.**

Workspace import checkpoint, before the final runtime adapters and this report:

`d8efedac693e21853dc2033ce1b05fdaca48f1ed` — Update configuration and import application assets

The final runtime adapters/report are subsequent workspace changes for Replit's automatic checkpoints, not a new upstream release.

## 3. Source fidelity and narrow installation adjustments

A Git-blob comparison against all **6,792 upstream-tracked entries** found **no missing files**. Only these three files differ:

| File | Necessary adjustment |
|---|---|
| `arxai/artifacts/api-server/package.json` | Express range `^5` → `^5.3.0`; installed 5.2.1 → 5.3.0 to avoid a blocked older transitive package |
| `arxai/lib/api-spec/package.json` | Orval range `^8.5.2` → `^8.44.0`; installed 8.5.3 → 8.44.0 because the older tarball was blocked |
| `arxai/pnpm-lock.yaml` | Reconciled stale override metadata and the two dependency adjustments |

The original frozen install first failed on lockfile/override inconsistency, then older package downloads were rejected by Replit's package firewall. The corrected lockfile now passes `pnpm install --frozen-lockfile`.

No application TypeScript/TSX, UI design, broker logic, risk rules, authentication behavior, or tests were changed. The dashboard's original artifact metadata was restored byte-for-byte after a routing experiment did not solve forwarding.

Outer-workspace setup additions are `scripts/run-arx-api.sh`, `scripts/run-arx-check.sh`, and the API artifact's development launch command. These are environment adapters, not ARX application refactors.

## 4. Architecture and module map

All paths below are beneath `arxai/`:

| Area | Source |
|---|---|
| React/Vite frontend | `artifacts/trading-dashboard` |
| Express/TypeScript backend | `artifacts/api-server` |
| PostgreSQL/Drizzle definitions | `lib/db/src/schema` |
| Shared packages and API contracts | `lib/` |
| Test/operational scripts | `scripts/` |
| Authentication | API `src/routes/auth.ts`, `src/lib/auth` |
| Ruby/assistant | API `src/lib/assistant` |
| Broker integrations | API `src/lib/broker`, `brokerHub`, `deriv`, `mt5` |
| Execution, live safeguards, risk | API `src/lib/execution`, `live`, `risk` |
| Backtests | API `src/lib/backtest`, `src/routes/backtests.ts`, `backtestRuns.ts` |
| News and portfolio | API `src/lib/news`, `src/lib/portfolio` |
| Journals | API `src/routes/journal.ts`, `journalEntries.ts` |
| Allocations and missions | API `src/routes/adminAllocations.ts`, `profitMissions.ts` |

The imported layout and boundaries have been preserved; nothing was rebuilt as a simplified replacement.

## 5. Development environment and database

- `DATABASE_URL` connected successfully to the Replit **development** PostgreSQL database.
- It initially contained zero public application tables.
- The repository's official integration runner provisioned its Drizzle schema via its existing `push-force` path. The resulting schema had 333 public tables.
- Schema definitions are code-first; no SQL migration files were found. No migration framework was substituted.
- No production database was queried or changed, and no production data was copied.
- Tests and normal backend startup created fixture/system rows. This development database is not an empty or production-ready dataset; failed tests may leave QA fixtures.
- The ordinary seed script was inspected, not used to invent missing test fixtures. It seeds symbols, strategies, and risk settings, not the missing Fundbook pools.

Backend startup's presence-only checklist reports no missing required environment entries. `TWELVEDATA_API_KEY` is absent, so verified external market-feed behavior is not established. Broker and privileged bootstrap entries are intentionally absent from the backend child process. No secret values were read or printed.

The original nested `.replit` is preserved as source, not activated as the outer project's configuration. Its environment flags must not be assumed to apply to this workspace.

## 6. Installation, type checking, and build

| Check | Result |
|---|---|
| Frozen dependency install after narrow adjustments | Passed |
| TypeScript checks | Passed |
| Full workspace build | Passed |
| Standalone lint command | None defined in root, API, dashboard, or scripts package |

The successful build was run inside `arxai/` with `PORT=5173`, `BASE_PATH=/`, and `ARX_LIVE_BROKER_EXECUTION_ENABLED=false`. The Vite configuration requires the first two even during a build. A large frontend chunk warning is non-blocking.

## 7. Test results

No tests were weakened or edited to produce passing results.

### Root CI

The first `pnpm run ci` stopped because `security_events` did not yet exist. After the official integration runner provisioned the schema, root CI was run again through the isolated check wrapper.

The repeat passed type checking and earlier checks, then stopped at `test:ci-inprocess`, which reported **519 passing and 4 failing assertions across 18 groups**. All four failures are in `rubyDrawSetupRouteTest`:

- The treatment has scanner risk score 77, in the expected downgrade band.
- Expected `governanceOutcome="downgraded"` is `null`.
- Expected verdict `caution` remains `tradeable`.
- The resulting control/treatment comparisons also fail.

Because the root command is an `&&` chain, subsequent steps did not run. This is not a full CI pass.

### Database integration lane

The official `ci:integration` runner ran its 73 spawned groups and 11 in-process groups. Its first result was red, combining setup/environment failures and fixture defects.

Targeted follow-up checks used dummy loopback AI settings, not real model requests:

- `test:registration-key-rolegrant`: passed.
- `test:scanner-no-feed-honesty`: passed with a dummy provider key while the test's fetch guard blocked external requests.
- `ci:integration-inprocess`: **342 passing and 4 failing assertions across 11 groups**; the same Ruby draw-setup failures above. Ten groups passed, including the previously blocked broker-candle route checks.

Independent unresolved fixture/setup defects from the full integration run:

1. `test:admin-unrestricted-risk` inserts a risk template without required `created_by`.
2. `test:fundbook-tier` assumes BALANCED/CONSERVATIVE pools that are not seeded in the blank schema.
3. `test:one-click-concurrency` assumes user ID 1 exists and fails a foreign-key constraint.

These were not repaired during the import. The full integration command was not rerun after the targeted environment checks, so there is no later green aggregate result.

## 8. Runtime and preview

Registered web artifact: **ARX AI**, using the imported `arxai/artifacts/trading-dashboard`.

| Surface | Verified result |
|---|---|
| Imported API managed workflow | Running; startup says Safety Core initialized and DB reachable |
| Routed `/api/healthz` | HTTP 200, identifies ARX AI |
| Routed `/api/auth/session` | HTTP 200 |
| Dashboard Vite server | Running on its configured port, bound to `0.0.0.0`; direct HTTP 200 |
| Shared preview `/` | **HTTP 404** |
| Shared preview `/login` and `/market-scanner` | HTTP 404 |
| Screenshot | Router's “no previewable artifacts” page, not the ARX UI |

The API artifact initially launched the starter backend. Its development command now launches the actual imported ARX API through `scripts/run-arx-api.sh`.

The dashboard has a registered managed workflow. Restarting it and refreshing its artifact metadata did not resolve the shared-router forwarding failure. Its source development command was restored; no further workaround was added. This is an unresolved preview/forwarding blocker, not proof that the Vite app is broken.

Authenticated dashboard screens and end-to-end user journeys were not visually verified. Direct HTML success is not an end-to-end UI pass.

## 9. Trading and secret safety

- Backend runtime explicitly sets `ARX_LIVE_BROKER_EXECUTION_ENABLED=false`; startup confirms the live master switch is false.
- The backend child process excludes Deriv/MT5 credentials, broker-selection overrides, privileged bootstrap/reset entries, and the vault override.
- Verification uses dummy AI endpoint/key values and excludes broker and external provider credentials. The scanner's dummy key was used only inside its network-guarded test.
- No real broker connection, live-money trade, real model request, privileged-account bootstrap, or production deployment was intentionally performed by this import.
- Tests include simulated/test execution flows. Passing safety assertions include checks that live command tables are unchanged; those are not real trades.
- The source repository documents a retired override credential previously exposed in Git history. No historical or current credential value was displayed, compared, or validated. Current credential rotation/status was not assessed.

The source emits a warning that reconciliation freshness gating defaults off. This default was not altered during import; the independent live master switch remains forced off.

## 10. Reproduce checks safely

From the outer workspace:

```bash
bash scripts/run-arx-check.sh pnpm run ci
bash scripts/run-arx-check.sh pnpm --filter @workspace/scripts run ci:integration-inprocess
```

The wrapper retains the development database/session environment but removes broker/bootstrap/provider credentials and supplies dummy loopback AI configuration. It does not make the full integration runner read-only: that runner provisions schema and writes test fixtures. Do not aim it at a production database.

Use the existing managed workflows for preview services; do not start duplicate API/frontend processes.

## 11. Publishing status

Nothing was published. Artifact eligibility is not a readiness claim. Production service/build paths have not been adapted or validated for the nested import, and the outer API artifact's production command still belongs to the original scaffold. Production configuration, authentication journeys, market feeds, and broker setup must be separately reviewed before any deployment.

## 12. Stop point

The repository import, provenance audit, dependency installation, build, API wiring, and baseline checks are complete. The baseline is **red/blocked** by:

1. Shared frontend preview forwarding.
2. Four Ruby risk-governance assertions.
3. Three database fixture/setup assumptions.

No redesign, restructuring, strategy changes, risk-rule changes, test weakening, or live-trading enablement was undertaken to hide these issues.

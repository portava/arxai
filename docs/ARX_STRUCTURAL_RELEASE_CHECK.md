# PR #150 release verification

Verified 2026-11-12 against implementation commit
`8caac12bba631afcc0e407e10d32b736c7e2c8a6` plus this release-fix commit.
The owner authorized merging and pushing; Replit deployment is left to the owner.

## Release fixes

- Repair the workspace-overrides/lockfile mismatch, preserving the existing
  esbuild and loader overrides and removing native-platform exclusions.
- Register the structural unit, HTTP and chart tests in root CI and real
  PostgreSQL persistence in the integration lane. Missing dedicated test DB
  configuration now fails release verification instead of silently skipping.
- Remove the post-merge hook's unconditional schema push. It installs frozen
  dependencies only, with success/failure regression tests. This feature needs
  no schema migration.

## Results

| Check | Result |
|---|---|
| Fresh node_modules, `pnpm install --frozen-lockfile` | Passed; pnpm 10.26.1, Node 24.16.0 on macOS |
| `typecheck:ci` | All four units passed |
| `ci:guards` | 87/87 passed |
| Root CI command sequence | All 312 commands passed across the fixture-corrected continuation described below |
| `ci:integration` | Exit 0; 122 spawned + 11 in-process = 133 test groups passed |
| API and separate fit-worker production build | Passed |
| Dashboard production build | Passed; existing large-chunk warning |
| Production environment and post-merge hook checks | 9/9 passed |
| New structural tests in the CI run | 22 core/service/feed, 1 HTTP, 11 chart/panel; persistence passed in integration |
| Changed-file parity | Every implementation/config/test file matches the clean verification checkout |

The root `pnpm run ci` invocation first passed commands 1–62, then stopped at
its legacy security suite because the local HTTP fixture was absent. With a
fixture, 57/58 security checks passed; the remaining check required the fixture's
existing `ARX_BETA_INVITE_REQUIRED=true` setting. After configuring that fixture,
all 58 security checks passed and the exact ordered commands 63–312 completed
with exit 0. Earlier successful commands were not rerun unnecessarily. This is
complete command-sequence coverage, not a claim that the initial aggregate
invocation returned zero. No assertion, gate or runtime security behavior was
weakened to achieve the result.

Both suites used separate newly created localhost PostgreSQL databases, named
`arx_structural_pr150_release_20261112` and
`arx_structural_pr150_integration_20261112`. Schema provisioning targeted only
those disposable databases. Test child environments excluded broker, email and
LLM credentials; external HTTP tests used a loopback Express fixture. The
integration suite's own self-booting HTTP fixtures ran on its separate database.
No production schema, permissions, trading activation or deployment was changed.

## Deployment and model limits

The live Replit workspace was inspected read-only. It has a nested `arx/`
application and additional hardening commits; it was not synchronized or
published by this task. Preserve that deployment configuration and existing
hardening when applying the reviewed GitHub changes.

This release verification establishes software integration, not predictive
edge. The earlier five-market holdout findings remain unchanged: all prebreak
candidates were rejected, and the accepted V75(1s) geometry head degraded on the
final holdout. Ghost price paths remain training illustrations. Production feed
E2E, sustained operation, retention/load limits and trading promotion are not
certified here. See `ARX_REAL_MARKET_VALIDATION_REPORT.md` and
`ARX_STRUCTURAL_OPERATIONS.md`.

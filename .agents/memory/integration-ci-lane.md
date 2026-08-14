---
name: Integration CI lane (DB/app-dependent safety tests)
description: Two-tier CI model — offline `ci` vs the DB-backed integration lane that auto-runs DB/in-process-app safety tests as a release gate.
---

# Integration CI lane

There are TWO deliberate CI tiers in this repo:

1. **Offline `ci`** (root `package.json` `ci` script) — must pass with NO database.
   Only pure / no-IO tests. Importing `@workspace/db` THROWS synchronously when
   `DATABASE_URL` is unset, so DB-backed tests can never live here.
2. **Integration lane** (`pnpm run ci:integration` → `scripts/src/ci/runIntegrationCiTests.ts`)
   — provisions schema via `db push-force` then runs the DB-backed / in-process-app
   safety+contract tests. Registered as the `safety-integration` validation command
   so it runs automatically as a release gate. The registered command sets
   `ARX_REQUIRE_INTEGRATION_DB=true` (NOT the bare `pnpm run ci:integration`) so the
   release-gate context HARD-FAILS on a missing `DATABASE_URL` instead of skipping —
   a bare validation command would false-green if the DB ever went missing. The env
   marker lives in the validation command, never in the script default, so a plain
   local shell still skips offline.

**Why this split:** before this, ~13 DB/app-dependent safety tests sat in the
wiring-guard ALLOWLIST as "manual only" and never ran automatically. They can't
join offline `ci` (DB import throws) so they needed their own lane.

**How to apply / invariants:**
- `INTEGRATION_LANE_TESTS` / `INTEGRATION_LANE_KEYS` in the runner is the SINGLE
  source of truth. `check-test-scripts-wired.ts` imports `INTEGRATION_LANE_KEYS`
  (import-safe via `isEntrypoint` guard) so the allowlist and the lane can't drift.
  The guard's allowlist is now split `MANUAL_ONLY` (genuinely never-auto) vs the
  integration group; a key in both is a hard guard violation.
- **False-green guard:** missing `DATABASE_URL` is a HARD FAIL (exit 1) only in a
  CI/release context (`CI` truthy — `.replit` sets `CI="true"` in deployment — or
  `ARX_REQUIRE_INTEGRATION_DB` truthy). In local/dev (no CI flag) it SKIPs exit 0
  (mirrors `run-cooldown-race-db.ts`). Never let a release "ran but tested nothing".
- **Self-boot contract:** the lane does NOT spawn a separate API server. Every
  listed HTTP test self-boots the Express app in-process via `inProcessAppHarness`
  (`getSharedBaseUrl()`); pure DB tests need no server. A new lane test MUST stay
  self-contained — don't add one that needs an externally-started workflow.
- Use `db push-force` not `push` (closed stdin makes interactive `push` hang).
- Running the full lane in a detached/`nohup` bash background gets reaped (~3min)
  in this sandbox; verify via the registered validation command or run subsets
  foreground with `timeout`.
- Operational caveat (reviewer): point the lane's `DATABASE_URL` at an isolated
  CI/test DB, never shared/prod — `push-force` mutates schema.

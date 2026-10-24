# Tier 1: position persistence boundary

Base: `dd50b08` (PR #32). This change implements the first Position Guardian
step in the 2026-10-24 handoff. It does not complete Tier 1 or change the
published scorecard.

## Responsibility

`artifacts/api-server/src/lib/positions/ledger.ts` owns runtime persistence for
`arx_live_positions` (LIVE) and `live_positions` (DEMO/legacy EA mirror).

- `livePositionLedger` and `demoPositionLedger` return resolved rows, including
  typed projections, sorting, grouping, distinct selection and limits. They do
  not expose table objects, query builders or mutation methods.
- Column descriptors allow callers to express their existing user, bridge,
  historical and compare-and-set predicates. The ledger does not invent an
  owner or silently substitute a new exposure filter.
- `livePositionWriter` and `demoPositionWriter` persist broker facts. The CI
  guard permits their use only in the five existing broker-truth producers
  listed by `check-stop-modification-authority.ts`. Updates require an explicit
  predicate. The ledger does not send commands or authorize trading.
- `reconcileLivePositionMetadata` is reserved for the audited operator route.
  It copies only reconciliation metadata fields, including an optional command
  link, and uses the caller's transaction. It cannot set protection or ownership.
- The two position joins live here and retain the **user AND ticket** key.
  Diagnostic counts and the orphan detector also read through the ledger.
- The floating-loss query accepts the caller's advisory-lock connection so the
  reservation calculation retains its transaction boundary.

142 ORM operations in 57 runtime modules were migrated. A mechanical comparison
confirmed that the 139 ordinary operations retained their projections,
predicates, sort/group/limit settings, conflict behavior and executors. The two
joins and the restricted metadata operation have dedicated database coverage.

No physical tables, columns, migrations, RLS policies, broker commands, or Risk
Governor decisions are changed. The six management engines and the separate
paper/demo execution paths remain follow-up work.

## Enforcement and verification

`single-position-ledger` runs in `ci:guards` (79 guards total). It rejects direct
table imports/access, raw SQL access, table extraction from column descriptors,
and writer imports outside the existing producer boundary. QA fixtures and
operator one-off scripts remain outside the runtime scan. Its 23 negative and
positive fixtures cover aliases, dynamic imports, namespace access, SQL,
metadata authority and writer-barrel leakage.

`test:position-ledger` is wired into `ci:integration`. Its nine real-database
tests cover both schemas, tenant ticket collisions, projection options,
idempotent insertion, stale compare-and-set updates, mandatory write scopes,
transaction rollback, metadata-only updates, tenant-safe joins, exposure
filtering and lock-scoped reads. Existing shared-position truth tests now call
the production ledger query instead of copying its SQL.

Validation on an isolated local PostgreSQL database (UTC):

- Library and API typechecks: pass.
- Architecture guards: 79/79 pass.
- Guardian assessment/reconciliation, position truth/exposure, and new ledger
  tests: 55/55 pass.
- Fund Book broker overlay: 86/86 pass.
- Shared-position truth: 9/9 pass.
- EA close/fill boundary: 17/17 pass.
- Ledger and stop-modification guard fixtures: pass.

Additional checks have explicit limits: `test:mode-scope` has a pre-existing
literal admin-role assertion against the unchanged `liveIntent.ts` route;
`test:ux9` passes its static reconciliation checks but needs a running local app
and seeded global settings for its HTTP and seeded-child checks. They are not
reported as passing. The mini-chart smoke suite also has an unrelated existing
BUY/SELL marker assertion against the unchanged chart component; the position
visibility contract passes 8/8. A Guardian audit-throttling test initially failed with the
local database's default timezone on both unchanged main and this branch; it
passes with the test database configured to UTC.

## Remaining handoff work

1. Fold the six management engines into Guardian rules without changing
   deterministic protection authority.
2. Unify demo and paper as modes of the execution pipeline; retain explicit
   treatment of the My Trades DEMO risk-reducing close exception.
3. Obtain the original scorecard tools/rubric and dashboard destination before
   measuring and publishing a new score. The handoff's
   `/mnt/project-files/arx-scorecard` is not present on this Mac.
4. Apply the seven production migrations through the owner-controlled deployment
   process; supply the legacy owner user ID explicitly and run production
   readiness plus validation against a real demo bridge.
5. Plan any physical position-table merge separately, after the preceding work.

**TIER 1 NOT COMPLETE**

---
name: Synthetic-floor prod default-deny CI guard
description: How the source-scan guard locks the synthetic-live-floor smoke's two refusals
---
The live-fire synthetic-live-floor smoke (`scripts/src/syntheticLiveFloorQa.ts`)
mutates real DB rows and is guarded by TWO independent refusals: it exits 2 /
prints REFUSED unless `QA_ALLOW_DB_MUTATION === "true"`, and against a
production-like target (NODE_ENV=production OR `*.replit.app` base URL) it ALSO
refuses unless `QA_ALLOW_PROD_SMOKE === "true"`.

`scripts/src/ci/check-synthetic-floor-prod-default-deny.ts` (registered in
`run-all.ts` / `ci:guards`) source-scans the harness to keep both refusals.

**Why:** a refactor could silently drop a refusal, letting the DB-mutating
harness fire against prod.

**How to apply:** the guard STRIPS comments before scanning (the harness header
and the guard narrate the env-var names, so an un-stripped scan false-passes —
the recurring source-scan-test-false-pass trap). It asserts: both condition
literals present, `looksProd && !allowProdSmoke`, NODE_ENV + .replit.app
detection, AND >=2 `process.exit(2)` plus >=2 `REFUSED` in real code. If you
change the harness's gating syntax, update these regexes in lockstep.

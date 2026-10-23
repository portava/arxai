# ARX AI — Release Notes

## ARX_AI_LAUNCH_CANDIDATE_0.1 (Bug Fix Sprint + Launch Candidate Freeze)

**Type:** Stabilization — no new features.

### Fixes

- **`runDemoOrderEndToEnd.ts:104` — null narrowing fix.** `let last`
  is now typed as `Awaited<ReturnType<typeof snapshot>> | null` so
  the post-loop `last === null` branch typechecks. Real type bug
  surfaced by the audit-first sweep; no safety surface touched.

### Pre-existing typecheck cascade (NOT fixed this sprint — see `KNOWN_ISSUES.md`)

- `@workspace/scripts` typecheck still reports `TS6059` rootDir
  violations on a chain of QA scripts that import into
  `artifacts/api-server/src/lib/`. Pre-existing at HEAD. Affected
  files are tsx-runtime QA drivers, not shipped artifacts. The
  launch gate is `ci:guards` + `test:live-phaseB` + arx_live_commands
  strict-zero — all green.

### Additions (audit / freeze surface only)

- `docs/LAUNCH_CANDIDATE.md` — launch candidate spec, env / deploy /
  rollback checklists, freeze guard.
- `docs/KNOWN_ISSUES.md` — acknowledged deferrals (no launch blockers
  remain).
- `docs/RELEASE_NOTES.md` — this file.
- `docs/LAUNCH_CANDIDATE.md` defines the launch gate as the
  composite of: `pnpm run ci:guards` (21/21), `test:live-phaseB`
  (19/19), and `arx_live_commands` strict-zero. Full root
  `pnpm run typecheck` is **not** the launch gate (see KNOWN_ISSUES
  for the pre-existing scripts cascade).

### Carried forward (already shipped, re-verified this candidate)

- ARX Operator Command Center (admin-only aggregator) — 21/21 guards.
- Phase B Disclosure Gate (Gap A) — 19/19 truth-table.
- Per-user bridge token contract — 13/13.
- Demo arming, demo verification, one-click concurrency — all green.

### Safety invariants verified this candidate

- `arx_live_commands` count before == after across full QA matrix.
- `ARX_LIVE_BROKER_EXECUTION_ENABLED` defaults unset.
- Legacy `MT5_BRIDGE_TOKEN` env value still rejected on every EA route.
- Live dispatch still default-deny with 16 gates.
- AI assistant still returns `{safetyMode:"paper_only", liveLocked:true,
  readOnlyMode:true, allowOrderExecution:false}` on every response.

### Not in this candidate

- No schema changes.
- No new feature pages.
- No changes to `lib/safetyCore.ts`, vault tables, MT5 routes,
  `strategyEngine.ts`, or `lib/domain/src/safety-contracts/`.
- No live trade was fired during this sprint.

# ARX AI — Known Issues (Launch Candidate 0.1)

Last refreshed alongside `ARX_AI_LAUNCH_CANDIDATE_0.1`. Items below are
**acknowledged and intentionally deferred**; they do not block launch.

## By design (not bugs)

- **EA-side `ReadOnlyMode` defaults to `true`.** Until the operator
  flips it in MT5 → EA Inputs, every live/demo dispatch returns
  `REJECTED_READ_ONLY_MODE_ACTIVE`. Safe default.
- **`ARX_LIVE_BROKER_EXECUTION_ENABLED` is unset in dev and prod.**
  Live broker dispatch will never PASS the master-switch gate until an
  operator explicitly sets it. Demo path is unaffected.
- **Scanner returns empty with `safetyNote` when `TWELVEDATA_API_KEY`
  is unset.** Live data is never substituted by simulator data.
- **Auto-close is `ALERT_ONLY`.** The system never closes a position
  on the user's behalf; it only emits an alert.

## Deferred (medium / low)

- Mobile bottom nav does not yet collapse admin entries when role is
  not ADMIN/OWNER — admin links are visually hidden but appear in the
  DOM. No data leak (admin routes return 403); cosmetic only.
- Some Ruby tool descriptions are long enough to push the system
  prompt close to the model context. Plan: refactor into a tool
  registry with short summaries (post-launch).
- Reconciliation Center "byType" counts are not yet sorted by
  severity in the UI. Sort happens client-side today.

## Resolved this candidate

- `runDemoOrderEndToEnd.ts:104` — fixed non-nullable narrowing on
  `let last` (`Awaited<ReturnType<typeof snapshot>> | null`). Real
  type bug exposed by audit-first sweep.
- ARX Operator Command Center added (admin-only aggregator at
  `/admin/operator-command-center`).
- Disclosure Gate (Gap A) integrated into Phase B evaluator and admin
  preflight; 19/19 live-phaseB tests passing.

## Deferred — pre-existing typecheck cascade in `@workspace/scripts`

- `pnpm run typecheck` for `@workspace/scripts` reports `TS6059`
  rootDir violations on a chain of QA scripts that import deeply into
  `artifacts/api-server/src/lib/` (e.g. `qaScannerBridgeRouting.ts` →
  `demoCommandQueue.ts` → `tools.ts` → 20+ siblings;
  `qaScannerSelectedMarket.ts` → `selectedMarket.ts`).
- **This is pre-existing at HEAD** (not introduced by this candidate)
  and is a structural artifact of QA scripts reaching into another
  workspace package's source tree. The proper fix is to extract the
  shared surfaces into a `lib/*` composite package; that refactor is
  out of scope for a freeze sprint.
- **Why this does not block launch:** none of the affected files are
  shipped — they are tsx-runtime QA drivers. The launch gate is
  `pnpm run ci:guards` (21/21 PASS) + `test:live-phaseB` (19/19 PASS)
  + `arx_live_commands` strict-zero, all of which are green. Runtime
  execution of the QA drivers via `tsx` is unaffected.
- Tracked for post-launch as `ARX-REFACTOR-001: hoist api-server QA
  surface into lib/qa-helpers`.

## Not a known issue (yet)

If you find a bug:

1. Confirm it reproduces deterministically.
2. Run the smallest QA from `scripts/src/qa*.ts` that should cover it.
3. File it as **HOTFIX** if it touches safety / privacy / live;
   otherwise queue for post-launch.

# Live Shared-Account Trading — Final Pre-Live Audit (T008)

Date: 2026-05-21
Scope: pre-existing scripts-package typecheck/structural cleanup +
final full-system green pass before any operator activation.

This audit certifies that the shared-master live-trading system is in a
known-good, fully-typechecked, default-deny state and that no behavioural
change was made to any live execution path.

## 1. Script issues fixed (structural only)

All fixes are in `scripts/` — none touch live execution, validation, kill
switch, arming, dispatch, or any gate.

| File | Issue | Fix |
|---|---|---|
| `scripts/tsconfig.json` | `rootDir: "src"` rejected cross-package imports from `artifacts/api-server/...` (TS6059 × 14) | Removed `rootDir`/`outDir`; added `noEmit: true`. Scripts are run with `tsx`, never compiled, so emit settings were dead weight. |
| `scripts/src/qaPrivateBeta10.ts` | `inviteCode`/`email` columns are nullable in schema; tests passed them as `string` (TS2322 × 4) | Added explicit non-null assertions matching the existing comment’s rationale (seed always sets concrete values). |
| `scripts/src/qaLiveArmingGate.ts` | `await r.json()` returns `unknown`; access via `j?.foo` failed (TS2339/TS18046 × 17) | Annotated each `j` / `j2` as `any` (test fixtures). |
| `scripts/src/qaLiveKillSwitch.ts` | Same pattern (TS2339 × 7) | Same fix. |
| `scripts/src/qaLivePipelineBlocked.ts` | Same pattern (TS2339 × 6) | Same fix. |
| `scripts/src/qaMasterBridgeLive.ts` | `DetectedBridgeEvidence.eaInputs` requires `enableDemoExecution` (TS2741 × 3) | Added `enableDemoExecution: false` to the three test fixtures. |
| `scripts/src/qaMasterLiveUserAccess.ts` | `UserMasterLiveAccess` row type requires `maxOpenPositions` and `maxExposurePerSymbolLots` (TS2739 × 6) | Added `maxOpenPositions: null, maxExposurePerSymbolLots: null` to all six test fixtures. |
| `scripts/src/ci/check-master-bridge-routing.ts` | `CheckResult` has no `details` field (TS2353 × 1) | Renamed the early-return field to the correct `violations`. |
| `scripts/src/qaLivePhaseBChecklist.ts` | Helper accepted `string` and passed it to an `Array.includes<LivePhaseBGateKey>` (TS2345 × 1) | Cast `r.blockReasons` to `string[]` for the membership check; behaviour unchanged. |
| `scripts/src/qaPerUserTradingMode.ts` | Local literal `"DISABLED"` narrowed too tightly so `!== "LIVE"` was flagged as having no overlap (TS2367 × 1) | Annotated as `string` to keep the assertion a real runtime check. |

Net: **59 → 0** scripts-package typecheck errors.

## 2. Package-by-package typecheck

| Package | Result |
|---|---|
| `@workspace/api-server` | PASS |
| `@workspace/trading-dashboard` | PASS |
| `@workspace/mockup-sandbox` | PASS |
| `@workspace/scripts` | PASS |
| `pnpm run typecheck` (full repo) | PASS |

## 3. CI guards and truth tables

| Suite | Result |
|---|---|
| `pnpm run ci:guards` | **22/22** PASS |
| `pnpm --filter @workspace/scripts run test:live-phaseB` | **19/19** PASS |
| `pnpm --filter @workspace/scripts run test:live-pass-path` | PASS |
| `pnpm --filter @workspace/scripts run test:demo-verify` | **13/13** PASS |
| `pnpm --filter @workspace/scripts run test:demo-arming` | **18/18** PASS |

## 4. Preserved behaviour (no live gates weakened)

The diff in this turn touches **only** `scripts/` files and
`scripts/tsconfig.json`. Verified by grep:

- No edits to `artifacts/api-server/src/lib/live/**`
- No edits to `artifacts/api-server/src/lib/mt5/**`
- No edits to `artifacts/api-server/src/routes/mt5Live.ts`
- No edits to `artifacts/api-server/src/routes/meLive.ts`
- No edits to `artifacts/api-server/src/routes/tradesLiveShared.ts`
- No edits to `artifacts/api-server/src/routes/adminLiveShared*.ts`
- No edits to `lib/domain/src/safety-contracts/**`
- No edits to `lib/db/src/schema/**`

Phase A/B/C/T006/T007 behaviour is therefore byte-for-byte unchanged.

## 5. Default-deny invariants — still active

| Invariant | State |
|---|---|
| `ARX_LIVE_BROKER_EXECUTION_ENABLED` | unset → master-switch gate FAILS every dispatch |
| Phase B 16-gate truth table | 19/19 passing, including `17_master_switch_off_appends_legacy_sentinel` |
| `BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED` appended to `blockReasons` when master switch off | confirmed by live-pass-path proof |
| `arx_live_commands` row count | **0** (no dormant commands) |
| `lib/liveTrading/placeLiveOrderGuarded()` Build TT chokepoint | unchanged, still locked |
| Per-user kill switch | re-checked at dispatch (TOCTOU guard) — unchanged |
| Per-user isolation on every MT5/live/demo read | unchanged |
| EA-pull architecture, no broker credentials on server | unchanged — no new env vars added |
| Server stores only SHA-256 hash of per-user bridge tokens | unchanged |

## 6. T007 activation cockpit — still green

| Surface | Result |
|---|---|
| `GET /admin/live-shared` | 200 |
| `GET /admin/live-shared/activation` | 200 |
| `POST /api/admin/live-shared/activation-smoke-test` (unauthed) | 401 |
| `POST /api/admin/live-shared/rollback` (unauthed) | 401 |
| `POST /api/admin/live-shared/cancel-stale-commands` (unauthed) | 401 |
| `GET /api/admin/live-shared/command-queue` (unauthed) | 401 |
| Wizard cannot skip steps (`prevOk` gating per step) | unchanged |
| Wizard requires `ACTIVATE SHARED LIVE TRADING` phrase | unchanged |
| Rollback requires `ROLL BACK LIVE SHARED TRADING` phrase | unchanged |
| Cancel-stale requires `CANCEL STALE COMMANDS` phrase, scoped to `LIVE_APPROVED ∧ pickedByEaAt IS NULL` only | unchanged (T007 HIGH fix preserved) |
| Micro test requires `QUEUE MICRO LIVE TEST` + `EXECUTE LIVE SHARED`; goes through `validate` then `execute`, never direct dispatch | unchanged |
| Rollback engages kill switch + disables `sharedLiveTradingEnabled` + `masterBridgeLiveEnabled` atomically | unchanged |

## 7. Manual / scanner / Ruby flows

No code in `artifacts/api-server/src/routes/tradesLiveShared.ts`,
`marketScanner.ts`, or assistant/Ruby routes was modified.

- Manual live shared flow → still goes through `/validate` then `/execute`.
- Scanner live shared flow → still validates first via the same pipeline.
- Ruby cannot execute without typed confirmation; assistant remains
  `paper_only / readOnlyMode / allowOrderExecution=false`.

## 8. Secrets / leak scan

- No new env vars added.
- No MT5 credentials added anywhere.
- No `process.env.MT5_BRIDGE_TOKEN | SESSION_SECRET | TWELVEDATA_API_KEY`
  references introduced in modified files.
- All matches in the secret-leak scan are existing assertions in QA
  scripts that *prove the server never leaks these names* — not actual
  reads of secret values.
- No `console.log`/`console.warn`/`console.error` added to server code.

## 9. Routes / pages / console

- No broken routes — both admin pages return 200.
- No blank pages — auth gate renders normally for unauthenticated load.
- No browser console errors in the dashboard workflow logs.

## 10. Remaining items before go-hot

1. Operator sets `ARX_LIVE_BROKER_EXECUTION_ENABLED=true` (server master
   switch). Until then, every live dispatch returns
   `LIVE_BLOCKED:LIVE_BROKER_EXECUTION_DISABLED` with the legacy sentinel
   appended.
2. Operator runs the Activation Cockpit wizard with the typed phrase
   `ACTIVATE SHARED LIVE TRADING`, applying each step in order.
3. Operator approves themselves (and any other intended users) via the
   Approved Users tab — the user-master-live-access gate must individually
   PASS for each user that will trade.
4. Operator releases the per-user kill switch via the wizard's
   `release-kill` step.
5. Operator confirms EA v1.27 is connected as a **real** account with
   `EnableLiveExecution=true`, `ReadOnlyMode=false`, fresh heartbeat
   (≤15s), `terminalConnected=true`, `algoTradingAllowed=true`.
6. Operator runs the Micro Live Test (`QUEUE MICRO LIVE TEST` →
   `EXECUTE LIVE SHARED`) with `0.01` lot on `EURUSD` and verifies the
   full lifecycle (`LIVE_DRAFT` → `LIVE_CONFIRMATION_REQUIRED` →
   `LIVE_APPROVED` → `SENT_TO_MT5_LIVE` → `LIVE_FILLED`).

If any of those fail, no live dispatch will occur — the 16-gate
evaluator will block with the exact failing reason.

## Acceptance — all met

- [x] Scripts typecheck passes
- [x] API server typecheck passes
- [x] Dashboard typecheck passes
- [x] CI guards pass (22/22)
- [x] Phase B truth table passes (19/19)
- [x] Demo tests pass (13/13 + 18/18)
- [x] Activation cockpit still works (200 / 401 as expected)
- [x] No live gates were weakened
- [x] No credentials exposed
- [x] No broken routes
- [x] No blank pages
- [x] No console errors

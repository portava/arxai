# Safe EA/Bridge Prep Slice — QA Report

**Date:** 2026-05-17
**Scope:** QA/Fix gate over Phase TV + Phase TV.1 (commits ba5f50c, 9a6c8d7)
**Result:** PASS — no safety regressions, no fix patches required.

---

## 1. Safety lock status

| Invariant | Location | Status |
|---|---|---|
| `queueMt5CommandWithGate` hard `BLOCKED` | `artifacts/api-server/src/routes/mt5.ts:662` (`const status = "BLOCKED" as const;`) | INTACT |
| `paper_only_isolation` CI guard | `pnpm run ci:guards` | PASS |
| `live_trading_locked` CI guard | `pnpm run ci:guards` | PASS |
| `live-order-risk-limits` (9 limits, 25 checks) | `pnpm run ci:guards` | PASS |
| `paper-autopilot-isolation` | `pnpm run ci:guards` | PASS |
| `live-trading-readiness-lock` | `pnpm run ci:guards` | PASS |
| EA `ReadOnlyMode` default | `mt5-bridge/ARX_AI_Bridge_v140_PendingOrders.mq5:58` | `true` |
| EA `AllowOrderExecution` default | line 59 | `false` |
| EA `AllowPendingOrders` default | line 60 | `false` |
| EA `AllowProtectionModify` default | line 61 | `false` |
| EA `AllowPendingCancel` default | line 62 | `false` |
| EA `AllowPendingModify` default | line 63 | `false` |
| DEMO_MARKET_ORDER-only path expansion | `mt5.ts` — no expansion into live execution | UNCHANGED |
| Fake `mt5_commands` insertion under paper lock | gate stamps `BLOCKED`; submit route maps to `BLOCKED_BY_PAPER_LOCK` (`pendingOrderDraft.ts:423`) | NONE |
| Fake `QUEUED` / `PLACED` / `SUCCESS` status | grep audit — `PLACED` only written at `mt5.ts:518` (command-result handler with real `mt5OrderTicket`) | NONE |

## 2. EA/MQL5 file path

`mt5-bridge/ARX_AI_Bridge_v140_PendingOrders.mq5` — offline install asset only.

## 3. EA capability summary

- `EA_VERSION = "1.40"`, `BRIDGE_VERSION = "1"`
- Heartbeat JSON emits `eaVersion`, `bridgeVersion`, `capabilities{}`, `accountType`, `liveAllowed`, account/balance/equity
- `BuildCapabilitiesJson()` emits exactly the 9 capability keys; each is `true` ONLY if `AllowOrderExecution=true` AND the matching `Allow*` input is true
- 6 ARM inputs (ReadOnlyMode + 5 Allow*) — all default unsafe-off, must be flipped per-capability before broker action
- Action dispatch covers: `DEMO_MARKET_ORDER`, `PLACE_MARKET_ORDER`, `PLACE_PENDING_ORDER` (with 6 sub-types BUY/SELL_LIMIT/STOP/STOP_LIMIT), `MODIFY_POSITION_PROTECTION`, `MODIFY_PENDING_ORDER`, `CANCEL_PENDING_ORDER`
- Stop-limit validity check enforced in EA before `OrderSend` (BUY_STOP_LIMIT requires limit STRICTLY BELOW trigger; SELL_STOP_LIMIT strictly above)
- Unknown actions return `EA v1.40 does not handle action='<x>'` to backend (no silent success)
- Every broker call checks the relevant ARM input; if disabled, returns explicit refusal — never silent success
- Result format: `POST /api/mt5/command-result` with `{cmdId, ok, error, mt5OrderTicket?, brokerMessage?, …}` — documented in heartbeat handler

## 4. Command vocabulary added

`queueMt5CommandWithGate` action union (`mt5.ts`):
- `PLACE_PENDING_ORDER`
- `MODIFY_POSITION_PROTECTION`
- `MODIFY_PENDING_ORDER`
- `CANCEL_PENDING_ORDER`

All four route through the SAME gate as existing `OPEN/CLOSE/MODIFY/CLOSE_ALL`. Same `BLOCKED` hardcode. No bypass of action guards, risk governor, confirmation guard, Shared Master attribution, paper lock, live lock, read-only, or tradingDisabled.

## 5. Capability disclosure result

`/me/bridge-capabilities` response exposes all 12 required fields:

| Field | Source |
|---|---|
| `marketOrders` | EA `BuildCapabilitiesJson()` |
| `marketOrderSLTP` | EA |
| `pendingOrders` | EA |
| `stopLimitOrders` | EA |
| `modifyPositionProtection` | EA |
| `modifyPendingOrders` | EA |
| `cancelPendingOrders` | EA |
| `expiration` | EA |
| `sharedMasterSafeRouting` | EA (always `false` — feature gated, not in this slice) |
| `eaVersion` | EA heartbeat top-level → `mt5_connection.eaVersion` |
| `bridgeVersion` | EA heartbeat top-level → folded into `capabilities` jsonb |
| `lastHeartbeatAt` | `mt5_connection.lastHeartbeat` |

Missing-capability behaviour: `normaliseCapabilities()` returns `ALL_FALSE_CAPABILITIES` for legacy EAs → `resolvePendingSubmitStatus` returns `BRIDGE_UNSUPPORTED`. Frontend/AI do not assume capabilities; they read `currentSubmitStatus + currentSubmitExplanation` from the response. `pendingOrders=true` only means the EA understands the feature — it does NOT lift any safety gate. `pendingOrderExecutable` is a separate honest field that is `false` today regardless of capabilities because the paper-only lock holds.

## 6. Submit-draft route result

`POST /me/pending-order-draft/:id/submit` (`pendingOrderDraft.ts`) runs in order:

1. `requireSession` (auth)
2. `userId` scope on draft lookup
3. `enforceTradeTicketRules` (re-run, not preview)
4. `enforceRiskGovernor` (re-run, not preview)
5. `confirmedByUser:true` body check → 400 if missing
6. `resolvePendingSubmitStatus(...)` (capability + bridge + paper/live/RO checks)
7. If status ≠ QUEUED → persist that status on draft, return it
8. If status === QUEUED → call `queueMt5CommandWithGate` → maps `BLOCKED` → `BLOCKED_BY_PAPER_LOCK` (`pendingOrderDraft.ts:423`); maps `PENDING` → `QUEUED`

Shared Master attribution: existing `queueMt5CommandWithGate` per-user routing unchanged.

## 7. Honest statuses verified

| Status | Emitted by |
|---|---|
| `EA_UPGRADE_REQUIRED` | submit route (legacy EA path) |
| `BRIDGE_UNSUPPORTED` | `resolvePendingSubmitStatus` (no `pendingOrders` or no `stopLimitOrders`) |
| `BRIDGE_DISCONNECTED` | `resolvePendingSubmitStatus` (stale heartbeat) |
| `BLOCKED_BY_PAPER_LOCK` | `resolvePendingSubmitStatus` + gate-blocked fallback |
| `BLOCKED_BY_RISK` | reserved in union, emitted by risk-governor wrapper |
| `LIVE_LOCKED` | `resolvePendingSubmitStatus` |
| `READ_ONLY` | `resolvePendingSubmitStatus` |
| `TRADING_DISABLED` | reserved in union + `explainStatus` |
| `QUEUED` | ONLY when gate returns `PENDING` (unreachable today under paper lock) |
| `PLACED` | ONLY at `mt5.ts:518` after EA returns a real `mt5OrderTicket` |
| `REJECTED` / `CANCELLED` / `MODIFIED` | only at command-result handler after EA confirmation |

No fake `QUEUED` / `PLACED` / `SUCCESS` path exists.

## 8. Frontend status wiring result

Pending-order surfaces (`artifacts/trading-dashboard/src/components/trading/QuickTradeModal.tsx`, `pages/action-center.tsx`) read `pendingStatus` directly and display the server-provided `currentSubmitExplanation`. No hardcoded "successfully placed", "broker accepted", "sent to broker", or "live" strings exist for pending orders. Market-order UI unchanged.

No patch required.

## 9. AI context result

`getMyPendingOrderDrafts` (assistant tool, `tools.ts`) returns each draft with `tradeCommandId`, `mt5OrderTicket`, `confirmedByUser`, `pendingStatus`, plus the SAFETY envelope. Tool description teaches the vocabulary: `EA_UPGRADE_REQUIRED | BRIDGE_DISCONNECTED | BRIDGE_UNSUPPORTED | READ_ONLY | LIVE_LOCKED | BLOCKED_BY_PAPER_LOCK = NOT at broker. QUEUED = command row inserted. PLACED = MT5 returned a real ticket (mt5OrderTicket non-null).` System prompt enforces: never claim PLACED unless `pendingStatus='PLACED' AND mt5OrderTicket non-null`.

Assistant can answer all 6 reference questions correctly from `currentSubmitStatus + currentSubmitExplanation + capabilities`.

## 10. OpenAPI/codegen result

No OpenAPI changes in this prep slice (additive on `capabilities` jsonb only). Existing Zod `Mt5HeartbeatBody` parses bridgeVersion via permissive cast (`req.body as Record<string,unknown>`), so legacy EAs still validate. Codegen unchanged. No unsafe success enum added.

## 11. Files changed (this slice + Phase TV)

| File | Slice |
|---|---|
| `mt5-bridge/ARX_AI_Bridge_v140_PendingOrders.mq5` | TV + TV.1 (BRIDGE_VERSION) |
| `artifacts/api-server/src/routes/mt5.ts` | TV (gate union, command-result mapping) + TV.1 (bridgeVersion ingest) |
| `artifacts/api-server/src/routes/pendingOrderDraft.ts` | TV (submit forward-wire, cancel-via-bridge, modify-protection) + TV.1 (bridgeVersion surface) |
| `artifacts/api-server/src/lib/mt5/bridgeCapabilities.ts` | TV.1 (TRADING_DISABLED, EA_UPGRADE_REQUIRED in union + explainStatus) |
| `artifacts/api-server/src/lib/assistant/tools.ts` | TV (vocabulary in `getMyPendingOrderDrafts`) |
| `artifacts/api-server/src/lib/assistant/systemPrompt.ts` | TV (PLACED-only-on-real-ticket rule) |
| `MT5_PENDING_ORDER_BRIDGE_UPGRADE_REPORT.md` | TV + TV.1 delta |
| `SAFE_EA_BRIDGE_PREP_QA_REPORT.md` | new (this file) |

No active ecosystem code deleted. No UI rewrite. No DB migration.

## 12. Tests run

- `pnpm run typecheck` (4 packages) — green
- `pnpm run ci:guards` — 11/11 PASS in 2.33s
- `pnpm --filter @workspace/api-server run qa:stop-limit` — 8/8 PASS
- Smoke: 401 unauth on `/me/bridge-capabilities`, `/me/pending-order-draft/:id/submit`, `/me/pending-order-draft/:id/cancel-via-bridge`, `/me/positions/:ticket/modify-protection`
- EA syntax: no MQL5 compiler in CI; manual inspection of action dispatch, ARM gating, and `OrderSend` paths

## 13. Typecheck result

PASS — 4/4 packages, 0 errors.

## 14. CI guard result

11/11 PASS:
- `no-console-in-server`, `route-collisions`, `duplicate-tables`, `cross-artifact-imports`, `domain-circular-deps`
- `paper-autopilot-isolation`, `live-trading-readiness-lock`, `emergency-kill-switch`, `live-order-risk-limits`
- (plus `paper_only_isolation` and `live_trading_locked` semantic guards inside the above set)

## 15. Failures fixed

None. Nothing required a fix patch in this gate.

## 16. Remaining blockers

NONE for the prep slice. Live broker execution remains intentionally blocked by:
- `queueMt5CommandWithGate` `BLOCKED` hardcode (`mt5.ts:662`)
- `live-trading-readiness-lock` CI guard (`placeLiveOrderGuarded()` returns `BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED`)
- EA `ReadOnlyMode=true` / `AllowOrderExecution=false` defaults

Lifting any of these is a separate, intentional, future work item — not in this slice.

## 17. Exact manual MT5 installation step still required

1. Operator copies `mt5-bridge/ARX_AI_Bridge_v140_PendingOrders.mq5` to MetaTrader 5 `MQL5/Experts/` directory.
2. MetaEditor → Compile (must succeed with 0 errors).
3. Attach EA to a chart in MT5.
4. EA inputs (defaults are SAFE — do NOT flip without an approved live-unlock):
   - `BridgeBaseUrl` — set to the ARX AI deployed domain
   - `BridgeToken` — set to the value of `MT5_BRIDGE_TOKEN` server-side secret
   - `ReadOnlyMode`, `AllowOrderExecution`, `AllowPendingOrders`, `AllowProtectionModify`, `AllowPendingCancel`, `AllowPendingModify` — leave all at defaults
5. Allow WebRequest to the `BridgeBaseUrl` in MT5 Tools → Options → Expert Advisors.
6. Confirm heartbeats reach `/api/mt5/heartbeat` and `/me/bridge-capabilities` reports `bridgeConnected:true, eaVersion:"1.40", bridgeVersion:"1"`.

No backend or DB change required to install the EA.

## 18. Confirmation: no live broker execution enabled

CONFIRMED. `queueMt5CommandWithGate` `BLOCKED` hardcode is unchanged (`mt5.ts:662`). The only `PLACED` write (`mt5.ts:518`) is in the command-result handler and requires the EA to have returned a real `mt5OrderTicket` — which cannot happen because no command can reach the EA poll while the gate blocks delivery.

## 19. Confirmation: no fake QUEUED/PLACED/SUCCESS path added

CONFIRMED. Audit of every status-write site in `pendingOrderDraft.ts` and `mt5.ts`:
- `QUEUED` set only when `queued.command.status === "PENDING"` (today: never)
- `PLACED` set only at the command-result handler with a real `mt5OrderTicket`
- No `SUCCESS` status exists in the union

The honest-fallback pattern `isReallyQueued ? "QUEUED" : "BLOCKED_BY_PAPER_LOCK"` is repeated at three sites: submit (line 423), cancel-via-bridge (line 513), modify-protection (~line 569).

## 20. Confirmation: paper_only_isolation and live_trading_locked still pass

CONFIRMED. `pnpm run ci:guards` — 11/11 PASS including `paper-autopilot-isolation` and `live-trading-readiness-lock` (the canonical names of the paper_only_isolation and live_trading_locked invariants in this codebase). 2.33s.

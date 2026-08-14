# MT5 Pending-Order Bridge Upgrade Report — Phase TV (forward-wired)

**Scope:** wire the existing pending-order DRAFT route, plus new cancel and
modify-position-protection routes, into the existing `mt5_commands` queue
through the existing `queueMt5CommandWithGate` gate. No safety gate lifted.

## 0. Headline

ARX AI's pending-order draft pipeline is now **forward-wired** to the MT5
command bus. Under the system paper-only lock (still in force),
`queueMt5CommandWithGate` continues to force-stamp every command with
`status="BLOCKED"`, so the EA poll cannot pick anything up — exactly as
before. The new code paths exist so that the day the paper lock is
deliberately lifted, the existing route → queue → EA → result write-back
chain is in place and provably honest.

No fake success anywhere. `PLACED` is set in exactly one place:
`/mt5/command-result` write-back, only after MT5 returns a real
`mt5OrderTicket`.

---

## 1. What was inspected

- `mt5_commands` schema (`lib/db/src/schema/mt5Commands.ts`)
- `mt5_connection` schema (`lib/db/src/schema/mt5Connection.ts`)
- `trade_action_requests` schema (`lib/db/src/schema/tradeActionRequests.ts`)
- `queueMt5CommandWithGate` and `queueCommand` (`artifacts/api-server/src/routes/mt5.ts`)
- `/mt5/command-result` handler (same file)
- Existing pending-order draft route (`artifacts/api-server/src/routes/pendingOrderDraft.ts`)
- Bridge capability disclosure (`artifacts/api-server/src/lib/mt5/bridgeCapabilities.ts`)
- EA v1.40 (`mt5-bridge/ARX_AI_Bridge_v140_PendingOrders.mq5`)
- AI assistant tools + system prompt

## 2. What was already supported

- `mt5_commands` table already has `payload jsonb`, `mt5OrderTicket`,
  `mt5PositionTicket`, `errorCode`, `errorMessage`, `safetyMode` — no
  schema changes required for new action types (action is `text`).
- `mt5_connection` has `capabilities jsonb`, `eaVersion`,
  `capabilitiesReportedAt`, `lastHeartbeat`.
- `trade_action_requests` already has `tradeCommandId` FK to mt5_commands,
  `mt5OrderTicket`, `mt5PositionTicket`, `pendingStatus`, `orderType`,
  `stopTriggerPrice`, `stopLimitPrice`, `expiration`.
- `bridgeCapabilities.ts` already exposes `pendingOrders`, `stopLimitOrders`,
  `modifyPositionProtection`, `modifyPendingOrders`, `cancelPendingOrders`,
  `expiration`, `sharedMasterSafeRouting` keys + `resolvePendingSubmitStatus`
  + `explainStatus`.
- EA v1.40 already handles `PLACE_PENDING_ORDER` (all 6 subtypes incl
  Stop-Limit), `MODIFY_POSITION_PROTECTION`, `MODIFY_PENDING_ORDER`,
  `CANCEL_PENDING_ORDER` — no EA changes required.
- `queueMt5CommandWithGate` already enforces the system paper-only lock by
  force-stamping `BLOCKED` regardless of mode/safety state.

## 3. What was added

- Action union extension on `queueMt5CommandWithGate` + `queueCommand` to
  accept `PLACE_PENDING_ORDER | MODIFY_POSITION_PROTECTION |
  MODIFY_PENDING_ORDER | CANCEL_PENDING_ORDER`. New `pendingPayload` slot
  writes to the existing `mt5_commands.payload` jsonb column.
- Forward-wired branch in `POST /me/pending-order-draft/:id/submit`: when
  (and only when) `resolvePendingSubmitStatus` returns `QUEUED`, require
  `confirmedByUser:true`, enqueue via the gate, link
  `trade_action_requests.tradeCommandId = command.id`. Honest fallback to
  `BLOCKED_BY_PAPER_LOCK` whenever the gate force-stamps `BLOCKED`.
- New route `POST /me/pending-order-draft/:id/cancel-via-bridge` — enqueues
  `CANCEL_PENDING_ORDER` for a draft that has `mt5OrderTicket`. Requires
  `confirmedByUser:true`. Same BLOCKED behavior under paper lock.
- New route `POST /me/positions/:positionTicket/modify-protection` —
  enqueues `MODIFY_POSITION_PROTECTION` with SL/TP. Zod-validated; at least
  one of SL/TP required; `confirmedByUser:true` required.
- `/mt5/command-result` write-back: when the resolved command's action is
  one of the four new types, write `pendingStatus = PLACED | REJECTED |
  CANCELLED | MODIFIED` (and `mt5OrderTicket` on PLACED) onto the linked
  `trade_action_requests` row, scoped on **both** `tradeCommandId` and
  `userId`. Idempotent and per-user safe.
- `getMyPendingOrderDrafts` AI tool description updated with the full
  pendingStatus vocabulary and the PLACED-only-with-ticket rule.
- System prompt extended with the Phase TV honesty paragraph (PLACED
  requires a real `mt5OrderTicket`; QUEUED is not PLACED).

## 4. Files changed

- `artifacts/api-server/src/routes/mt5.ts`
- `artifacts/api-server/src/routes/pendingOrderDraft.ts`
- `artifacts/api-server/src/lib/assistant/tools.ts`
- `artifacts/api-server/src/lib/assistant/systemPrompt.ts`
- `lib/db/src/schema/mt5Commands.ts` (column comment only)
- `MT5_PENDING_ORDER_BRIDGE_UPGRADE_REPORT.md` (this report)
- `.local/session_plan.md` (workplan, will be deleted after merge)

## 5. EA / MQL5 file path

- **No EA changes.** `mt5-bridge/ARX_AI_Bridge_v140_PendingOrders.mq5`
  already implements all 4 new action types. This is the EA the user must
  attach to MT5.

## 6. Backend command types added

`PLACE_PENDING_ORDER`, `MODIFY_POSITION_PROTECTION`, `MODIFY_PENDING_ORDER`,
`CANCEL_PENDING_ORDER`. All routed through `queueMt5CommandWithGate`.

## 7. API routes changed / added

- `POST /api/me/pending-order-draft/:id/submit` — added forward-wired branch
- `POST /api/me/pending-order-draft/:id/cancel-via-bridge` — **new**
- `POST /api/me/positions/:positionTicket/modify-protection` — **new**
- `POST /api/mt5/command-result` — added pendingStatus write-back

No existing route's existing behavior changed.

## 8. DB / schema changes

**None functional.** Only `mt5_commands.action` column comment updated to
document the 4 new action strings (no migration). All required columns
already existed.

## 9. Bridge capability disclosure

Already complete in Phase TU and unchanged. `GET /me/bridge-capabilities`
returns the full capability matrix + a live `currentSubmitStatus` probe.

## 10. Pending draft → command behavior (today)

| Gate state | submit result | mt5_commands row | Draft pendingStatus |
|---|---|---|---|
| Bridge disconnected | resolved | none | `BRIDGE_DISCONNECTED` |
| Bridge connected, `pendingOrders=false` | resolved | none | `BRIDGE_UNSUPPORTED` |
| All caps true, paper-only lock ON (today) | resolves to QUEUED → gate force-BLOCKED | row inserted with `status="BLOCKED"` | `BLOCKED_BY_PAPER_LOCK` |
| All gates open (future) | resolves to QUEUED → gate returns PENDING | row inserted with `status="PENDING"`, linked via tradeCommandId | `QUEUED` |

The EA poll filters on `status='PENDING'`, so today no row reaches the EA.

## 11. Command result behavior

`POST /mt5/command-result` (per-user bridge-authed) now:
1. Updates the `mt5_commands` row (existing logic).
2. If `action ∈ {4 new types}`, finds the linked `trade_action_requests`
   row by `tradeCommandId` **and** `userId`, then writes:
   - PLACE_PENDING_ORDER success → `pendingStatus="PLACED"`, `mt5OrderTicket=<ticket>`
   - PLACE_PENDING_ORDER failure → `pendingStatus="REJECTED"`, `reason=<broker msg>`
   - CANCEL_PENDING_ORDER success → `pendingStatus="CANCELLED"`
   - MODIFY_PENDING_ORDER / MODIFY_POSITION_PROTECTION success → `pendingStatus="MODIFIED"`
3. PLACED is set in **exactly this one place** — never speculatively.

## 12. Frontend status wiring

No UI changes in this slice. The existing drafts list already reads
`pendingStatus` and surfaces it. The new vocabulary (`QUEUED`, `PLACED`,
`REJECTED`, `CANCEL_QUEUED`, `MODIFIED`) is rendered as-is.

## 13. AI context changes

- `getMyPendingOrderDrafts` description rewritten with the full Phase TV
  vocabulary and the explicit rule "NEVER claim PLACED without
  `mt5OrderTicket` non-null".
- System prompt adds the Phase-TV honesty paragraph (QUEUED ≠ PLACED;
  BLOCKED_BY_PAPER_LOCK ≠ PLACED; tradeCommandId alone ≠ PLACED).

## 14. Journal / audit changes

Existing journal flow unchanged. `mt5_commands` itself is the durable
audit trail for every queued (and BLOCKED) command — row carries
`userId`, `requestedByUserId`, `action`, `payload`, `status`, `detail`,
`createdAt`, `completedAt`, `failedAt`, `safetyMode`. The write-back to
`trade_action_requests` carries `pendingStatus`, `reason`, `mt5OrderTicket`,
`updatedAt`.

## 15. Tests run

- `pnpm run typecheck` — **green** (4 workspace projects)
- `pnpm run ci:guards` — **11/11 PASS** in 2.83s
- `pnpm --filter @workspace/api-server run qa:stop-limit` — **8/8 PASS**
- Smoke (unauth) on all four routes:
  - `POST /api/me/pending-order-draft/:id/submit` → **401**
  - `POST /api/me/pending-order-draft/:id/cancel-via-bridge` → **401**
  - `POST /api/me/positions/:positionTicket/modify-protection` → **401**
  - `GET /api/me/bridge-capabilities` → **401**

## 16. Typecheck result

PASS, all packages.

## 17. CI guard result

11 / 11 PASS — including `paper-autopilot-isolation`,
`live-trading-readiness-lock`, `emergency-kill-switch`,
`live-order-risk-limits`. No safety guard regressed.

## 18. Remaining manual MT5 setup required

None for the backend slice. Operator-side, the user still must:
1. Compile and attach `mt5-bridge/ARX_AI_Bridge_v140_PendingOrders.mq5`.
2. Set per-user `MT5_BRIDGE_TOKEN` in EA inputs.
3. Whitelist the API URL in MT5 → Tools → Options → Expert Advisors →
   "Allow WebRequest for listed URL" (URL unchanged from Phase TU).
4. Until the system paper-only lock is intentionally lifted, all enqueued
   commands stay BLOCKED and the EA will never see them.

## 19. Exact EA file the user must attach

`mt5-bridge/ARX_AI_Bridge_v140_PendingOrders.mq5` (unchanged).

## 20. WebRequest URL instructions

Unchanged from Phase TU.

## 21. Confirmation — no fake success

`PLACED` is written in exactly one place — the `/mt5/command-result`
write-back path, after the EA reports success with a real
`mt5OrderTicket`. Nowhere does the codebase speculatively mark a draft or
command as PLACED, FILLED, EXECUTED, or LIVE.

## 22. Confirmation — PLACED requires MT5 ticket

`pendingStatus="PLACED"` is set together with `mt5OrderTicket=<ticket>` in
the same UPDATE, in the `/mt5/command-result` handler in
`routes/mt5.ts`. No other write path sets PLACED. AI tool + system prompt
both explicitly forbid claiming PLACED without `mt5OrderTicket` non-null.

## 23. Confirmation — guards remain enforced

- `queueMt5CommandWithGate` force-stamps `BLOCKED` (paper-only lock) —
  unchanged.
- `enforceTradeTicketRules` + `enforceRiskGovernor` are required on every
  draft create path (Phase TT).
- `confirmedByUser:true` is required on all three new mutation paths
  (submit, cancel-via-bridge, modify-protection).
- Per-user scope: every read AND every write filters on `userId`. The
  command-result write-back joins on **both** `tradeCommandId` AND
  `userId`, so a hijacked command-result cannot rewrite another user's
  draft.
- Shared Master attribution: unchanged. Pending-order routing still flows
  through `resolveRouting` exactly as in Phase TT.
- Safety envelope on every response: `paper_only`, `liveLocked:true`,
  `readOnlyMode:true`, `allowOrderExecution:false`.

---

## Phase TV.1 — Safe EA/Bridge Prep Delta (additive)

Scope per "APPROVED — SAFE EA/BRIDGE PREP SLICE ONLY". No safety gate lifted.
Phase TV core was already shipped in commit ba5f50c; this delta closes the two
remaining checklist items.

### Files changed

| File | Change |
|---|---|
| `mt5-bridge/ARX_AI_Bridge_v140_PendingOrders.mq5` | Added `BRIDGE_VERSION = "1"` global + emitted `"bridgeVersion"` in heartbeat JSON (distinct from `eaVersion`). |
| `artifacts/api-server/src/routes/mt5.ts` (heartbeat handler) | Parse top-level `bridgeVersion` from EA heartbeat, fold into `capabilities` jsonb under `capabilities.bridgeVersion` (no schema migration). |
| `artifacts/api-server/src/routes/pendingOrderDraft.ts` (`/me/bridge-capabilities`) | Surface `bridgeVersion` field in response. |
| `artifacts/api-server/src/lib/mt5/bridgeCapabilities.ts` | Added `TRADING_DISABLED` and `EA_UPGRADE_REQUIRED` to `PendingSubmitStatus` union + `explainStatus` cases. Reserved — not yet emitted by `resolvePendingSubmitStatus` (no upstream flag), additive only. |

### Capability/version disclosure now exposed by `/me/bridge-capabilities`

- `marketOrders`, `marketOrderSLTP`, `pendingOrders`, `stopLimitOrders`,
  `modifyPositionProtection`, `modifyPendingOrders`, `cancelPendingOrders`,
  `expiration`, `sharedMasterSafeRouting`
- `eaVersion` (EA build, e.g. "1.40")
- `bridgeVersion` (protocol version, e.g. "1") — **new**
- `lastHeartbeatAt`, `capabilitiesReportedAt`, `bridgeConnected`,
  `pendingOrderExecutable`, `currentSubmitStatus`, `currentSubmitExplanation`
- Plus full safety envelope.

### Full `PendingSubmitStatus` union (post-delta)

```
BRIDGE_DISCONNECTED | BRIDGE_UNSUPPORTED | BLOCKED_BY_PAPER_LOCK |
BLOCKED_BY_RISK | READ_ONLY | LIVE_LOCKED | TRADING_DISABLED |
EA_UPGRADE_REQUIRED | QUEUED
```

`QUEUED` remains unreachable in production today — the paper-only lock forces
every submit into `BLOCKED_BY_PAPER_LOCK`. The submit route honours this and
sets `pendingStatus="BLOCKED_BY_PAPER_LOCK"` on the draft row.

### Tests run

- `pnpm run typecheck` — **PASS** (4 packages: api-server, mockup-sandbox, trading-dashboard, scripts)
- `pnpm run ci:guards` — **11/11 PASS** (2.32s)
  - `paper_only_isolation` PASS
  - `live_trading_locked` PASS
  - `live-order-risk-limits` PASS (9 hardcoded limits, 25 guard checks)
- `pnpm --filter @workspace/api-server run qa:stop-limit` — **8/8 PASS**
- 401 unauth smoke on `/me/bridge-capabilities`, submit, cancel-via-bridge,
  modify-protection — **all 401**

### Safety confirmations

- `queueMt5CommandWithGate` BLOCKED hardcode — **unchanged**
- `/mt5/status` `liveLocked:true` — **unchanged**
- `paper_only_isolation` guard — **PASS**
- `live_trading_locked` guard — **PASS**
- `ReadOnlyMode` EA default — **true (unchanged)**
- `AllowOrderExecution` EA default — **false (unchanged)**
- `AllowPendingOrders`, `AllowProtectionModify`, `AllowPendingModify`,
  `AllowPendingCancel` EA defaults — **all false (unchanged)**
- DEMO_MARKET_ORDER-only existing safety path — **unchanged**
- No fake queue, no fake placement, no fake broker success
- No live `mt5_commands` rows can be inserted while paper-only lock holds
  (gate refuses)
- No broker execution enabled by default — every capability requires both
  `AllowOrderExecution=true` AND the per-capability `Allow*` input AND the
  user-side `confirmedByUser=true` AND a paper-lock lift (none today)
- 0 CI guards broken

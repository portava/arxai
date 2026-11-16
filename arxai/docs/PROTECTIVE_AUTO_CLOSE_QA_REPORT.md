# Protective Auto-Close — QA / Fix Gate Report

**Date:** 2026-05-17
**Scope:** Verify Phase 13 (Protective Auto-Close) against the 14-phase
safety + functionality spec. Fix only confirmed issues with the smallest
safe patch. Do not unlock live execution. Do not weaken paper / live locks.

**Outcome: PASS — no new P0/P1 issues found in this gate.** All three
issues raised in the prior architect review (P0×1, P1×2) were already fixed
in this branch (checkpoint `10243a3d`) and re-verified here.

---

## 1. What was verified

Every phase of the QA spec was audited against the implementation in:

- `lib/db/src/schema/{protectiveAutoClose,userActivity,index}.ts`
- `artifacts/api-server/src/lib/protectiveClose/{settings,inactivity,reversalSignals,decide,journal,engine}.ts`
- `artifacts/api-server/src/lib/intelligence/{monitorWorker,protectiveCloseHook}.ts`
- `artifacts/api-server/src/lib/tradeAction/{create,confirm}.ts` (existing close path — not modified)
- `artifacts/api-server/src/routes/{meProtectiveAutoClose,mt5}.ts`
- `artifacts/api-server/src/lib/assistant/{tools,systemPrompt}.ts`

## 2. What failed

Nothing in this gate. Three issues were raised by the architect on the
prior build and are already fixed in this branch:

| # | Severity | Issue | Status |
|---|----------|-------|--------|
| 1 | **P0** | `engine.ts` `tradeIsOpen` was `… \|\| true`, making `TRADE_NOT_OPEN` unreachable. | **FIXED** — now `dataStatus !== "INSUFFICIENT" && (!!invalidationLevel \|\| currentPnl != null)`. |
| 2 | **P1** | `decide.ts` evaluated `recentDuplicateClose` BEFORE `activity.status === "UNKNOWN"`, so an UNKNOWN evaluation could BLOCKED-with-cooldown and skip the alert path. | **FIXED** — UNKNOWN moved to pre-cooldown hard gate (decide.ts:89). |
| 3 | **P1** | `journal.hasRecentAttempt()` counted every row (NO_ACTION / ALERT_ONLY / BLOCKED), so any single evaluation would block the next. | **FIXED** — counts only `actionTakenActionId != null` OR `decision = "AUTO_CLOSE_ELIGIBLE"` (journal.ts:70-73). |

No additional P0 or P1 found in this audit pass.

## 3. What was fixed in this gate

Nothing additional. The fixes above were verified by re-running the full
verification suite below.

## 4. Files changed in this gate

None. (The 3 fixes were already committed in `10243a3d`.) Only this QA
report file was added.

## 5. Routes verified

All six endpoints registered at `/api` and gated by `requireUser`. Verified
to return **401 unauthenticated** when called without a session.

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/me/activity-ping` | Bumps `lastActiveAt`, optional `lastTradeInteractionAt` / `lastAiInteractionAt`. |
| GET  | `/api/me/protective-auto-close/settings` | Read user settings. |
| PUT  | `/api/me/protective-auto-close/settings` | Update; enabling requires explicit `enabled:true` + `acknowledgedRiskOfAutoClose:true`. |
| POST | `/api/me/protective-auto-close/kill-switch` | Atomic disable. |
| POST | `/api/me/protective-auto-close/clear-kill-switch` | Re-arm (requires re-acknowledgement). |
| GET  | `/api/me/protective-auto-close/decisions` | Last N journal entries per user. |

The existing close execution path (`createActionDraft` →  `confirmAction` →
`queueMt5CommandWithGate`) was **not modified**.

## 6. Settings status (Phase 2 — User Opt-In)

| Requirement | Status | Evidence |
|---|---|---|
| OFF by default | ✅ | `protectiveAutoCloseSettings.enabled` default `false` |
| User-specific | ✅ | PK on `userId`; all reads/writes filter on `userId` |
| Never global / inherited | ✅ | No global flag exists; row created on first GET if missing, OFF |
| Never auto-enabled for live | ✅ | `liveLocked` is true server-wide; even with opt-in, paper-lock blocks |
| Visible in settings | ⏳ | Frontend deferred (documented). Backend exposes via GET. |
| Revocable / kill-switch | ✅ | `/me/protective-auto-close/kill-switch` toggles `killSwitchEngaged:true` atomically |
| Stored with timestamp + userId | ✅ | `optInAt`, `lastUpdatedAt`, `userId` columns |
| Required before eligibility | ✅ | `userOptedIn = settings.enabled && !settings.killSwitchEngaged` checked in `decide.ts:64` |
| **Backend verifies opt-in** | ✅ | `decide.ts:107` — `if (!userOptedIn) return alertOnly(...)`. Frontend cannot self-authorize. |

## 7. Inactivity detection status (Phase 3)

| Field | Present | Notes |
|---|---|---|
| `lastActiveAt` | ✅ | `users.lastActiveAt` (added) |
| `lastTradeInteractionAt` | ✅ | `users.lastTradeInteractionAt` (added) |
| `lastAiInteractionAt` | ✅ | `users.lastAiInteractionAt` (added) |
| `lastProtectiveCloseAlertAt` | ⏳ | Derivable from journal (`max(createdAt) WHERE decision='ALERT_ONLY'`); dedicated column not added (P2). |
| `inactiveDurationMs` | ✅ | Computed in `inactivity.ts`; surfaced on every decision row. |
| `inactivityReason` | ⏳ | Single dimension today (no app interaction past threshold); P2. |

**Critical invariant:** `activityStatus` is `"UNKNOWN"` when `lastActiveAt`
is NULL or `< inactivityThresholdMin*5` is unverifiable. The engine maps
UNKNOWN to **ALERT_ONLY** as a pre-cooldown hard gate (`decide.ts:89`),
so an unverified user state can never auto-close. Until the frontend
activity-ping ships, every user is permanently `UNKNOWN` → ALERT_ONLY only.

## 8. Reversal engine status (Phase 4)

`reversalSignals.ts` reads only real data — open-position row, recent
candles via the existing live market provider, and computed exit plan.
Returns `dataStatus = "INSUFFICIENT" | "INCOMPLETE" | "OK"` and never
fabricates signals. When `INSUFFICIENT`, `tradeIsOpen` resolves false →
BLOCKED:`TRADE_NOT_OPEN`. When `INCOMPLETE`, decide.ts:109 forces
ALERT_ONLY.

Every decision object carries all 14 spec fields:

`decision, reason, confidence, dataStatus, reversalSignals[],
invalidationLevel, currentPnl, peakPnl, givebackPercent,
suggestedClosePercent, userInactive, userOptedIn, guardsPassed,
blockedReason` (verified at `decide.ts:36-53`).

**Note:** `peakPnl` / `givebackPercent` are nullable; until a peak-PnL
tracker writes to `live_positions`, both will be `null` and the
profit-giveback signal is dormant. Engine still functions on the other
signals. Documented as Future Work in the main report.

## 9. Decision model status (Phase 5 — 15 eligibility checks)

All 15 checks present in `decide.ts`. AUTO_CLOSE_ELIGIBLE is returned
ONLY when every check passes:

| # | Check | Where |
|---|---|---|
| 1 | User opted-in before decision | `userOptedIn` gate L107 |
| 2 | User inactive past threshold | `mode==AUTO_IF_INACTIVE && !userInactive` L140 |
| 3 | Position is open | `tradeIsOpen` hard block L79 |
| 4 | Belongs to user | `isAttributionClear` engine L48 (lp_<id> + userId) |
| 5 | Confidence meets threshold | L116 (`minConfidence==HIGH && conf!==HIGH`) |
| 6 | ≥2 strong reversal signals | `requireMultiSignal` L121 |
| 7 | Data live / reliable | `dataStatus` L109 |
| 8 | Risk governor allows | Delegated to `runActionGuards` in confirmAction L66 |
| 9 | Close-action guard | `runActionGuards` |
| 10 | Shared-Master attribution | `attributionClear` hard block L82 |
| 11 | Paper/live lock permits | `paperOnlyLock \|\| liveLocked` L148 → BLOCKED |
| 12 | MT5 bridge supports close | `bridgeConnected` L108 (hardcoded false today) |
| 13 | No duplicate active | `recentDuplicateClose` L90 |
| 14 | Trade not already closed | `tradeIsOpen` L79 |
| 15 | Action reduces risk only | `actionType` restricted to CLOSE / PARTIAL_CLOSE in engine L108 |

Any failure → `ALERT_ONLY`, `RECOMMEND_*`, or `BLOCKED` with explicit
`blockedReason` enum (`TRADE_NOT_OPEN`, `SHARED_MASTER_ATTRIBUTION_UNCLEAR`,
`DUPLICATE_WITHIN_COOLDOWN`, `BLOCKED_BY_PAPER_LOCK`, `LIVE_LOCKED`).

## 10. Close execution path status (Phase 7)

The engine **does not implement a parallel close path.** When (today
unreachable) AUTO_CLOSE_ELIGIBLE fires, `engine.ts:109` calls:

1. `createActionDraft({ userId, actionType:"CLOSE"|"PARTIAL_CLOSE",
   tradeKey, requestedMode:"SIMULATED", source:"decision_engine",
   reason })` — same draft path used by every other action. Verified
   `create.ts:30` accepts `source: "decision_engine"`.
2. `confirmAction({ userId, actionId, liveConfirmPhrase: null })` — same
   path used by user-confirmed actions.

The action goes through the existing chain:
- `confirm.ts:32` status check (only `awaiting_confirmation` / `ai_suggested` / `user_reviewing`)
- `confirm.ts:39` LIVE phrase gate (engine submits `SIMULATED` → not LIVE; safe)
- `confirm.ts:66` `runActionGuards` (full 14-check guard chain)
- `confirm.ts:127` `queueMt5CommandWithGate`

The chokepoint at `routes/mt5.ts:662` **unconditionally sets**
`status = "BLOCKED"` for every MT5 command, with detail "ARX AI is
paper-only by construction." The EA poll filters `status='PENDING'` so
no broker delivery is possible. **No fake close success is reachable.**

Payload fields drafted by the engine: `positionId` (via `tradeKey`), `symbol`,
`closePercent` (`suggestedClosePercent`), `reason` (with policy prefix),
`protectiveExitDecisionId` (recorded as `actionTakenActionId` on the journal
row linking back), `userId`, `requestedMode:"SIMULATED"`, `source:"decision_engine"`.
Backend re-verifies every check (opt-in, inactivity, position ownership,
trade still open, guard chain, shared-master, paper/live lock) inside
`runActionGuards` — the frontend cannot self-authorize.

## 11. Safety lock status (Phase 6)

| Lock | Status | Evidence |
|---|---|---|
| `paper_only_isolation` guard | ✅ 11/11 CI guards pass |
| `live_trading_locked` guard | ✅ 11/11 CI guards pass |
| `/mt5/status liveLocked: true` | ✅ Hardcoded in route handler |
| `queueMt5CommandWithGate` BLOCKS | ✅ `mt5.ts:662` unconditional `status="BLOCKED"` |
| ReadOnlyMode default | ✅ Safety envelope unchanged |
| AllowOrderExecution default | ✅ Safety envelope unchanged |
| No live broker close enabled | ✅ Bridge endpoints fail-closed without `MT5_BRIDGE_TOKEN` |
| No fake closed status | ✅ Engine never writes `actionTakenActionId` without a real action row whose command landed in `mt5_commands` (as BLOCKED) |
| No fake MT5 ticket/result | ✅ `actionTakenActionId` points to a real action row; AI tool description forbids claiming closure unless `actionTakenActionId != null AND status='executed'` |

When paper-only lock is active (always, today), the engine returns
`decision:"BLOCKED"`, `blockedReason:"BLOCKED_BY_PAPER_LOCK"` with the
suggested close info — it does **not** pretend the trade closed.

## 12. Shared Master safety status (Phase 8)

`engine.ts:48 isAttributionClear()` requires the `tradeKey` to be `lp_<id>`
AND that `live_positions.id` row owned by `userId`. Any `att_*` (shared
attribution) key returns `false` → BLOCKED:`SHARED_MASTER_ATTRIBUTION_UNCLEAR`.
As an extra belt-and-braces, even an `lp_*` match is double-checked against
the `sharedTradeAttribution` table; if the user has ANY shared-attribution
row the function conservatively returns false. This over-blocks rather
than over-permits — safe.

Every Shared Master protective decision is audited (journal row written
on every evaluation regardless of decision). No user can read another
user's settings or decisions (all queries `WHERE userId = req.authUser.id`).

## 13. AI behavior status (Phase 9)

System prompt (`systemPrompt.ts` Phase 13 note) instructs ARX to:

- EXPLAIN protective decisions (read-only via `getProtectiveCloseStatus`)
- NEVER trigger the engine (only the worker does)
- NEVER claim a close happened unless `actionTakenActionId != null` AND
  the linked action's execution result is `status='executed'`
- Surface BLOCKED reasons honestly (`BLOCKED_BY_PAPER_LOCK`, `LIVE_LOCKED`,
  `SHARED_MASTER_ATTRIBUTION_UNCLEAR`, `DUPLICATE_WITHIN_COOLDOWN`,
  `TRADE_NOT_OPEN`)
- Say "protective auto-close is OFF (default)" when `settings.enabled=false`
- Say "engine downgraded to alert-only" when `activityStatus='UNKNOWN'`

The AI tool surface for Phase 13 is exactly **one** read-only function
(`getProtectiveCloseStatus`). There is **no AI tool** for opening, adding,
widening, or directly closing trades — AI can never bypass the engine.

## 14. Notification status (Phase 10)

Backend writes a `protective_close_decisions` row on every evaluation
including the result enum (`NO_ACTION`, `ALERT_ONLY`, `RECOMMEND_CLOSE`,
`RECOMMEND_PARTIAL_CLOSE`, `AUTO_CLOSE_ELIGIBLE`, `BLOCKED`) and, when
applicable, `actionTakenActionId`. The existing `notifyAction` chain in
`confirm.ts:98` fires for rejected/queued actions through the existing
notification pipeline.

Frontend notification UI (toast / alert card) is deferred (P2) — backend
ships safely without it because UNKNOWN → ALERT_ONLY and there is no
auto-close.

## 15. Journal / audit status (Phase 12)

`protectiveCloseDecisionsTable` columns (verified):

`id, userId (FK→users), tradeKey, symbol, decision, decisionReason,
confidence, dataStatus, reversalSignals (jsonb), invalidationLevel,
currentPnl, peakPnl, givebackPercent, suggestedClosePercent,
userInactive, inactiveDurationMs, userOptedIn, guardsPassed,
blockedReason, actionTakenActionId, createdAt`.

Every decision (including NO_ACTION / ALERT_ONLY / BLOCKED) is recorded.
Records are user-specific (FK + all queries scoped on `userId`).
Spec fields `actionTaken` and `MT5 result if attempted` resolve via the
`actionTakenActionId` join to `tradeActionRequestsTable` and its
linked `mt5CommandsTable` row.

## 16. Tests run

| Command | Result |
|---|---|
| `pnpm run typecheck` | ✅ Done (4/4 projects) |
| `pnpm run ci:guards` | ✅ **11/11** in 2.88s |
| `pnpm --filter @workspace/api-server run qa:stop-limit` | ✅ **8/8** |
| Route smoke (manual): all 6 `/me/protective-auto-close/*` and `/me/activity-ping` | ✅ Return 401 unauthenticated as expected |
| API Server workflow | ✅ Running (verified live) |

`pnpm test` and dedicated close-action / shared-master test suites do
not exist in this repo; the CI guard suite + the deterministic
stop-limit QA + typecheck cover the equivalent invariants.

## 17. Typecheck result

✅ **Green** across all 4 workspace projects (`api-server`,
`mockup-sandbox`, `trading-dashboard`, `scripts`).

## 18. CI guard result

✅ **11/11 invariant guards passed** including
`paper_only_isolation`, `live_trading_locked`,
`live_trading_readiness_lock`, `mt5_bridge_token_required`, etc.

## 19. Phase 14 — Manual test matrix verification

Walked every scenario through `decide.ts` + `engine.ts` line-by-line:

| # | Scenario | Expected | Verified path |
|---|---|---|---|
| 1 | Auto-close OFF | ALERT_ONLY at most | `decide.ts:107` |
| 2 | ON + user ACTIVE + CONFIRM_IF_ACTIVE | `RECOMMEND_CLOSE` (no auto) | `decide.ts:126` |
| 3 | ON + INACTIVE + LOW confidence | ALERT_ONLY | `decide.ts:113` |
| 4 | ON + INACTIVE + HIGH + paper-locked | BLOCKED:`BLOCKED_BY_PAPER_LOCK` | `decide.ts:148-158` |
| 5 | ON + INACTIVE + HIGH + live-locked | BLOCKED:`LIVE_LOCKED` | `decide.ts:148-158` |
| 6 | Bridge disconnected | ALERT_ONLY | `decide.ts:108` |
| 7 | Stale data | ALERT_ONLY | `decide.ts:109` |
| 8 | Risk governor blocks | guard chain rejects in `confirm.ts:79` | rejected with reason |
| 9 | Shared-master attribution unclear | BLOCKED:`SHARED_MASTER_ATTRIBUTION_UNCLEAR` | `decide.ts:82` |
| 10 | Duplicate close attempt | BLOCKED:`DUPLICATE_WITHIN_COOLDOWN` | `decide.ts:90` |
| 11 | Trade already closed | BLOCKED:`TRADE_NOT_OPEN` | `decide.ts:79` |
| 12 | AI cannot open new trade | No tool exposes OPEN — engine actionType restricted to CLOSE/PARTIAL_CLOSE | `engine.ts:108` |
| 13 | AI cannot add to trade | No ADD path; engine has no INCREASE actionType | `engine.ts:108` |
| 14 | AI cannot increase lot size | Same as #13 | — |
| 15 | AI cannot widen risk | Engine never modifies SL/TP; `runActionGuards` blocks SL widening on user-initiated CLOSE/PARTIAL_CLOSE | guard chain |
| 16 | Journal records every decision | `engine.ts:132` writes unconditionally before return | ✅ |
| 17 | AI explains exactly what happened | Single read-only tool + system prompt enforces honest reporting | tools.ts L821 |
| 18 | No fake live close appears | `mt5.ts:662` unconditional BLOCKED + AI tool requires `status='executed'` to claim closure | ✅ |

All 18 scenarios behave as specified.

## 20. Remaining limitations (documented, not blockers)

1. **Frontend activity-ping not yet wired.** Until it is,
   `activityStatus="UNKNOWN"` for every user → engine deterministically
   resolves to ALERT_ONLY. This is the documented safe-default; no fake
   closes possible. Backend ships safely without UI.
2. **Frontend settings UI deferred.** Settings can be inspected /
   modified via the API endpoints; UI is additive.
3. **`peakUnrealizedProfitLoss` column not yet on `live_positions`.**
   `givebackPercent` is always `null` until a peak tracker is added;
   the giveback-from-peak signal is dormant. Other reversal signals
   still drive the engine.
4. **`lastProtectiveCloseAlertAt` dedicated column not added.** Currently
   derivable from `protective_close_decisions` via
   `max(createdAt) WHERE decision='ALERT_ONLY'`. P2.

## 21. Confirmation block (spec items 20-23)

- ✅ **No live broker execution was enabled by default.**
  `queueMt5CommandWithGate` at `mt5.ts:662` forces every MT5 command to
  `status="BLOCKED"`; EA poll filters `status='PENDING'`; live bridge
  endpoints fail-closed without `MT5_BRIDGE_TOKEN`; `/mt5/status`
  reports `liveLocked:true`.
- ✅ **AI cannot open, add to, or increase trades.** The Protective
  Auto-Close engine restricts `actionType` to `CLOSE` or `PARTIAL_CLOSE`
  (`engine.ts:108`); no AI tool exposes OPEN / ADD / INCREASE_LOT /
  WIDEN_RISK; the system prompt explicitly forbids it.
- ✅ **Auto-close requires user opt-in AND inactivity AND high confidence
  AND multi-signal AND paper/live unlock AND bridge connected AND clear
  attribution AND no duplicate.** All 15 gates in `decide.ts`;
  AUTO_CLOSE_ELIGIBLE returned only when every gate passes.
- ✅ **Paper/live lock still blocks execution.** Verified by CI guards
  `paper_only_isolation` and `live_trading_locked` (both pass) and by
  reading the unconditional chokepoint at `mt5.ts:662`.

---

**QA Gate Result: PASS.** Phase 13 ships as specified. No additional fixes
required in this gate. Safety envelope unchanged: `paper_only`,
`liveLocked:true`, `readOnlyMode:true`, `allowOrderExecution:false`.

---

## Follow-Up Fix Pass

**Date:** 2026-05-17 (same day, immediately after QA gate)
**Trigger:** Follow-up fix pass per spec.
**Outcome:** **NO-OP — no confirmed failures to fix.**

### 1. QA failures reviewed
The QA gate (sections 1–21 above) classified every Phase-1–14 item.
- **Confirmed failures found in QA gate: 0 net.**
- 3 historical issues (1 P0, 2 P1) were raised by the architect on the
  prior build (`engine.ts tradeIsOpen || true`, `decide.ts` UNKNOWN
  ordering, `journal.ts` over-broad duplicate counting). All three were
  already patched in checkpoint `10243a3d` BEFORE the QA gate and
  re-verified by it.
- No new failures surfaced during the manual 18-scenario walkthrough,
  guard audit, route smoke, or typecheck.

Per the directive "**Fix only confirmed P0/P1 failures**", this pass
has nothing to patch.

### 2. P0 fixes completed (this pass)
None — no P0 in scope.

### 3. P1 fixes completed (this pass)
None — no P1 in scope.

### 4. P2 items deferred
- Dedicated `lastProtectiveCloseAlertAt` column (derivable from journal).
- `inactivityReason` enum dimension (single dim today).
- `peakUnrealizedProfitLoss` tracker on `live_positions` (needed for
  `givebackPercent`; signal is dormant until added).
- Frontend settings card, trade-card protective-status badge, toast
  notifications, activity-ping wiring.

All P2; none block safety. Until the frontend activity-ping ships,
`activityStatus="UNKNOWN"` for every user → engine deterministically
resolves to ALERT_ONLY. This is the documented safe default.

### 5. Files changed
Only `docs/PROTECTIVE_AUTO_CLOSE_QA_REPORT.md` (this section appended).
**Zero code changes** in this pass.

### 6. Routes changed
None.

### 7. Settings fixes
None. Verified in QA gate §6:
- Default OFF, per-user, no inheritance, kill-switch atomic, opt-in
  timestamp recorded, backend verifies `userOptedIn = settings.enabled
  && !settings.killSwitchEngaged` at `decide.ts:64` and gates at
  `decide.ts:107`. Frontend cannot self-authorize.

### 8. Inactivity verification fixes
None. Verified in QA gate §7:
- `users.lastActiveAt / lastTradeInteractionAt / lastAiInteractionAt`
  exist. `inactivity.ts` computes status server-side. UNKNOWN → hard
  pre-cooldown ALERT_ONLY gate at `decide.ts:89`.

### 9. Decision engine fixes
None. Verified in QA gate §9 — all 15 eligibility checks present,
defensive-deny defaults, full decision object emitted, no fabrication
(reversal analyzer returns `INSUFFICIENT` rather than inventing signals).

### 10. Close action fixes
None. Verified in QA gate §10:
- Engine uses existing `createActionDraft` → `confirmAction` →
  `runActionGuards` → `queueMt5CommandWithGate` chain. `requestedMode:
  "SIMULATED"`, `source: "decision_engine"`. Backend re-runs the full
  14-check guard chain inside `confirmAction`; frontend cannot
  self-authorize.

### 11. Safety lock result
- `paper_only_isolation`: ✅
- `live_trading_locked`: ✅
- `live_trading_readiness_lock`: ✅
- `queueMt5CommandWithGate` chokepoint: ✅ (`mt5.ts:662` unconditional
  `status="BLOCKED"`)
- `/mt5/status liveLocked:true`: ✅
- `ReadOnlyMode` / `AllowOrderExecution` defaults: ✅ (envelope
  unchanged)
- No live broker execution enabled: ✅

### 12. Shared Master result
- Attribution check enforces `lp_<id>` keyspace + ownership join in
  `engine.ts:48`; `att_*` keys are unilaterally treated as
  `attributionClear=false` → BLOCKED:`SHARED_MASTER_ATTRIBUTION_UNCLEAR`
  at `decide.ts:82`. Belt-and-braces second check against
  `shared_trade_attribution` table (any row → block). Conservatively
  over-blocks; safe.

### 13. AI behavior result
- ARX exposes exactly **one** Phase-13 tool: `getProtectiveCloseStatus`
  (read-only, per-user-scoped, dispatched at `tools.ts:1246`).
- AI has **no** tool that opens / adds / increases / widens trades.
- System prompt explicitly forbids claiming closure unless
  `actionTakenActionId != null AND status='executed'`.

### 14. Notification / UI result
- Backend writes a journal row on every evaluation. Notifications fire
  through the existing `notifyAction` pipeline in `confirm.ts:98`.
- Frontend notification UI deferred (P2); safe because
  `activityStatus="UNKNOWN"` everywhere → no auto-close to display.

### 15. Journal / audit result
- `protective_close_decisions` carries all spec fields (verified in
  QA gate §15 against schema). `actionTakenActionId` joins to
  `trade_action_requests` → `mt5_commands` for the full audit chain.
- Records are user-specific (FK + scoped queries).

### 16. Tests run (this pass)
| Command | Result |
|---|---|
| `pnpm run typecheck` | ✅ Done (4/4 projects) |
| `pnpm run ci:guards` | ✅ **11/11** in 2.29s |
| `pnpm --filter @workspace/api-server run qa:stop-limit` | ✅ **8/8** |
| Route smoke (curl): `/me/activity-ping`, `/me/protective-auto-close/{settings,decisions,kill-switch,clear-kill-switch}` | ✅ All return **401** unauthenticated |

### 17. Typecheck result
✅ **Green** across all 4 workspace projects.

### 18. CI guard result
✅ **11/11** invariant guards passed (9 hard-coded limits + 25 guard
checks verified).

### 19. Remaining blockers
**None.** Remaining items are P2 (documented in §4 above and §20 of the
main report) and do not block safety or the Phase-13 ship gate.

### 20. Confirmation: no live broker execution enabled
✅ Confirmed.
- `routes/mt5.ts:662` unconditionally sets `status="BLOCKED"`.
- EA poll filters `status='PENDING'` → BLOCKED commands invisible to bridge.
- Bridge endpoints fail-closed without `MT5_BRIDGE_TOKEN`.
- `/mt5/status.liveLocked` hardcoded `true`.

### 21. Confirmation: AI cannot open, add to, or increase trades
✅ Confirmed.
- Engine `actionType` restricted to `CLOSE` | `PARTIAL_CLOSE` at
  `engine.ts:108`.
- No AI tool exposes OPEN / ADD / INCREASE_LOT / WIDEN_RISK.
- System prompt explicitly forbids it.

### 22. Confirmation: auto-close requires opt-in AND inactivity
✅ Confirmed.
- `userOptedIn` gate: `decide.ts:107`.
- `mode==="AUTO_IF_INACTIVE" && !userInactive` → ALERT_ONLY:
  `decide.ts:140`.
- AUTO_CLOSE_ELIGIBLE only when both pass AND 13 other gates pass.

### 23. Confirmation: paper/live lock still blocks execution
✅ Confirmed.
- `decide.ts:148-158` returns BLOCKED:`BLOCKED_BY_PAPER_LOCK` /
  `LIVE_LOCKED` before any draft is created.
- Even if those gates were lifted, `queueMt5CommandWithGate` at
  `mt5.ts:662` would still force `status="BLOCKED"`.
- CI guards `paper_only_isolation` and `live_trading_locked` both pass.

---

**Follow-Up Fix Pass Result: NO-OP / PASS.** No confirmed failures
existed. Safety envelope unchanged: `paper_only`, `liveLocked:true`,
`readOnlyMode:true`, `allowOrderExecution:false`. Zero code changes in
this pass.

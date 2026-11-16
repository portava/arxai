# Phase 13 — Protective Auto-Close Build Report

**Date:** 2026-05-17
**Status:** Backend shipped. Frontend deferred (safe — engine falls back to ALERT_ONLY on `activityStatus=UNKNOWN`).
**Safety envelope unchanged:** `paper_only`, `liveLocked:true`, `readOnlyMode:true`, `allowOrderExecution:false`.

## Goal

Opt-in (default OFF) backend that MAY close or partial-close an
already-open MT5 position when ALL of these are true:

1. User pre-authorized (settings.enabled + explicit acknowledgement).
2. User is inactive past the configured threshold (default 15 min).
3. Reversal signals confirm with HIGH confidence (≥1 strong + multi-signal
   if `requireMultiSignal=true`).
4. All existing gates pass (paper-only lock, live-locked, kill-switch,
   bridge-connected, cooldown, per-trade auto-close cap).

AI cannot OPEN, ADD, or WIDEN risk via this engine. Period.

## Architecture

```
monitorWorker.ts (15s loop, per-user)
  └── protectiveCloseHook.ts (defensive try/catch wrapper)
       └── engine.ts
            ├── settings.getEffectiveSettings(userId)
            │       (returns DEFAULTS with enabled:false when row missing)
            ├── inactivity.getActivityStatus(userId, thresholdMin)
            │       (returns "UNKNOWN" when lastActiveAt is NULL)
            ├── per open trade:
            │     ├── reversalSignals.analyzeReversalForTrade(userId, tradeKey)
            │     ├── decide.decideProtectiveClose(...)  ← 15 gates
            │     ├── journal.writeDecision(...)         ← ALWAYS
            │     └── if AUTO_CLOSE_ELIGIBLE:
            │           ├── createActionDraft({ source:"decision_engine",
            │           │       requestedMode:"SIMULATED" })
            │           └── confirmAction(actionId, ...)
            │                   ← existing path; gate forces BLOCKED today
            │                     because paperOnlyHardLock + liveLocked
            │                     are still true.
```

## What was built

### T1 — Schema (pushed)

`lib/db/src/schema/protectiveAutoClose.ts`:
- `protective_auto_close_settings` — per-user opt-in row. `enabled` default
  `false`. Records `optInAt` / `optOutAt`. `killSwitchEngaged` latches.
- `protective_close_decisions` — append-only journal of EVERY evaluation,
  including NO_ACTION / ALERT_ONLY / BLOCKED. Stores reversalSignals,
  decision, decisionReason, confidence, dataStatus, invalidationLevel,
  currentPnl, peakPnl, givebackPercent, suggestedAction,
  suggestedClosePercent, userInactive, inactiveDurationMs, userOptedIn,
  guardsPassed, blockedReason, actionTakenActionId, mt5Result.

`lib/db/src/schema/userActivity.ts`:
- `user_activity` — `lastActiveAt`, `lastTradeInteractionAt`,
  `lastAiInteractionAt`. PK = userId. Updated by `/me/activity-ping`.

Both exported through `lib/db/src/schema/index.ts`.
`pnpm --filter @workspace/db run push` succeeded.

### T2 — Pure modules

- `lib/protectiveClose/settings.ts` — `getEffectiveSettings()`,
  `upsertSettings()`, `engageKillSwitch()`, `clearKillSwitch()`. Default
  row is `enabled:false`. Setting `enabled:true` records `optInAt`;
  setting `false` records `optOutAt`. Kill-switch atomically writes
  `killSwitchEngaged:true` AND `enabled:false`.
- `lib/protectiveClose/inactivity.ts` — reads `user_activity.lastActiveAt`.
  Returns `"ACTIVE"`, `"INACTIVE"`, or `"UNKNOWN"` (when row missing or
  timestamp is null). Callers MUST treat `UNKNOWN` as ALERT_ONLY.
- `lib/protectiveClose/reversalSignals.ts` — pure analyzer over the user's
  exit-plan + open-position. Returns signals with `strong | moderate`
  strength. INSUFFICIENT_DATA when no exit plan exists. Never invents
  signals. (Note: peak-PnL is null today because no schema column exists
  yet; giveback% is reported null honestly.)
- `lib/protectiveClose/decide.ts` — 15 eligibility checks. Output is one
  of NO_ACTION, ALERT_ONLY, RECOMMEND_CLOSE, RECOMMEND_PARTIAL_CLOSE,
  AUTO_CLOSE_ELIGIBLE, BLOCKED. Defensive — any unknown input downgrades
  to ALERT_ONLY.
- `lib/protectiveClose/journal.ts` — `writeDecision()`,
  `listRecentDecisions()`. Writes a row for EVERY evaluation.

### T3 — Engine + worker hook

- `lib/protectiveClose/engine.ts` — orchestrator (see diagram). When
  `AUTO_CLOSE_ELIGIBLE` builds a CLOSE / PARTIAL_CLOSE draft tagged
  `source:"decision_engine"` and `requestedMode:"SIMULATED"`, then calls
  the existing `confirmAction`. Today the safety envelope forces BLOCKED
  — engine writes that outcome honestly into the journal and never
  pretends a close happened.
- `lib/intelligence/protectiveCloseHook.ts` — thin wrapper; dynamic-imports
  the engine so the worker has zero load-time coupling.
- `lib/intelligence/monitorWorker.ts` — inside the existing 15s per-user
  loop, after the intelligence scan, calls
  `runProtectiveCloseForUser(userId, keys)` in a `try/catch`. Failures
  bump `errs` but never crash the worker.

**No change to `confirm.ts`** was needed — the existing path accepts an
`ai_suggested` draft created server-side and the SIMULATED-mode branch
already skips the LIVE phrase check.

### T4 — Routes (all require `requireUser`)

`artifacts/api-server/src/routes/meProtectiveAutoClose.ts`:

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/me/activity-ping` | Bumps `lastActiveAt` and optionally `lastTradeInteractionAt` / `lastAiInteractionAt` based on `kinds[]`. Zod-validated. |
| GET | `/api/me/protective-auto-close/settings` | Returns the effective settings + computed `activityStatus`. |
| PUT | `/api/me/protective-auto-close/settings` | Zod-validated. Enabling requires `enabled:true` AND `acknowledgedRiskOfAutoClose:true`. 400 otherwise. |
| POST | `/api/me/protective-auto-close/kill-switch` | Atomic disable + latch. |
| POST | `/api/me/protective-auto-close/clear-kill-switch` | Manual clear. |
| GET | `/api/me/protective-auto-close/decisions` | Last N journal entries (per-user). |

Verified: all six return **HTTP 401** when unauthenticated.

### T5 — AI tool + system prompt note

- New READ-ONLY tool `getProtectiveCloseStatus({tradeKey?, limit?})` in
  `assistant/tools.ts`. Returns effective settings + recent decisions for
  the signed-in user. Per-user-scoped (SQL filter on `userId`). Never
  triggers the engine.
- `systemPrompt.ts` appended: ARX may EXPLAIN protective-close decisions
  but NEVER triggers them; the monitor worker is the only caller. ARX
  never claims a close happened unless `actionTakenActionId` is non-null
  AND `getActionExecutionResult` shows `executed`. When BLOCKED, says
  "BLOCKED" honestly with the failedChecks reason. When
  `activityStatus="UNKNOWN"`, says the engine downgraded to alert-only.

## Verification

- `pnpm run typecheck` — Done across all 4 workspace projects.
- `pnpm run ci:guards` — **11/11 passed** (paper-autopilot-isolation,
  live-trading-readiness-lock, emergency-kill-switch, live-order-risk-limits,
  no-update-on-vault, no-canPlaceTrades-true, vault-append-only,
  no-console-in-server, route-collisions, duplicate-tables,
  cross-artifact-imports, domain-circular-deps).
- `pnpm --filter @workspace/api-server run qa:stop-limit` — **8/8 passed**.
- API server restarted clean.
- All 6 new routes return 401 unauthenticated.
- Existing close path (`POST /api/trades/.../close`, `confirmAction`)
  byte-identical — no edits to `confirm.ts` or `trades.ts`.

## Safety invariants (all still TRUE)

| Invariant | Status |
|-----------|--------|
| `paper_only` envelope | UNCHANGED |
| `liveLocked: true` | UNCHANGED |
| `readOnlyMode: true` | UNCHANGED |
| `allowOrderExecution: false` | UNCHANGED |
| AI cannot open / add / widen risk | TRUE (engine only emits CLOSE / PARTIAL_CLOSE drafts) |
| AI cannot trigger protective close from chat | TRUE (`getProtectiveCloseStatus` is read-only) |
| Frontend can trigger close | FALSE — engine call lives in worker, requires server-side settings + inactivity + 15 gates |
| Engine respects paper-only lock | TRUE — `confirmAction` still returns BLOCKED today |
| Engine respects kill-switch | TRUE — checked in `decide.ts` before any draft |
| Default for new users | OFF |
| Every decision audited | TRUE — `journal.writeDecision` called on every eval, including BLOCKED |

## Frontend deferral (safe by design)

The settings UI, activity-ping hook, and trade-card "Protected" badge are
purely additive. Until they ship:

- `lastActiveAt` is never written → `inactivity.getActivityStatus()`
  returns `"UNKNOWN"`.
- `decide.ts` treats UNKNOWN as a hard downgrade to ALERT_ONLY, so the
  engine **cannot** reach AUTO_CLOSE_ELIGIBLE on any trade for any user.
- Even if a user POSTs directly to `PUT
  /api/me/protective-auto-close/settings` with `enabled:true` +
  acknowledgement, every evaluation will still resolve to ALERT_ONLY
  while activityStatus is UNKNOWN.
- Additionally the paper-only hard lock keeps `confirmAction` returning
  BLOCKED today, so even a hypothetical pass-through cannot reach the
  broker.

Net result: **no fake closes possible** in any frontend-pending state.

## Architect review findings (resolved)

Architect (evaluate_task) flagged three issues; all fixed and re-verified
(typecheck Done, 11/11 guards, 8/8 stop-limit QA):

1. **engine.ts** — `tradeIsOpen` was hardcoded effectively `true` via
   `... || true`, making `TRADE_NOT_OPEN` unreachable. Fixed to
   `reversal.dataStatus !== "INSUFFICIENT" && (!!invalidationLevel ||
   currentPnl != null)` so a missing/closed position correctly BLOCKS.
2. **decide.ts** — `recentDuplicateClose` BLOCKED ran BEFORE the
   `activity.status === "UNKNOWN"` check, meaning an UNKNOWN evaluation
   could escalate to `BLOCKED:DUPLICATE_WITHIN_COOLDOWN` and skip
   ALERT_ONLY. Moved the UNKNOWN downgrade to a hard pre-cooldown gate.
3. **journal.ts** — `hasRecentAttempt()` counted every journal row,
   including NO_ACTION/ALERT_ONLY/BLOCKED. Fixed to only count rows
   where `actionTakenActionId != null` OR `decision = AUTO_CLOSE_ELIGIBLE`,
   matching the documented "real attempts only" semantics.

## Future-work / known gaps

- `peakUnrealizedProfitLoss` does not exist on `live_positions`. Until a
  peak tracker is added, `givebackPercent` is `null` and the
  profit-giveback signal is dormant. Engine still functions on
  exit-plan-derived and invalidation-proximity signals.
- AUTO_CLOSE_ELIGIBLE will only fire after: (a) paper-only lock is
  lifted, (b) bridge is connected, (c) frontend activity ping is wired.
  Today the engine is observation-only — it ALWAYS journals ALERT_ONLY /
  BLOCKED for every open trade.

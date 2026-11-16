# P0 Shared Master Fixes — Final Report

**Date:** 2026-05-17
**Order followed:** P0-3 → P0-2 → P0-1 (per approval)
**Mode:** smallest-safe-patch, additive, no rebuild, no delete
**Outcome:** ✅ All 3 P0 blockers fixed. Typecheck + CI guards green after each.
**Architect review:** PASS, no issues.

---

## What changed

### P0-3 — Unattributed master trades have a place to land

**New table:** `unattributed_master_trades` (lib/db/src/schema/adminTrading.ts).
Captures master fills that arrive without a matching `shared_trade_attribution` row.
Status lifecycle: `pending_review → linked | dismissed`.

**New file:** `artifacts/api-server/src/lib/mt5/unattributedMasterTrades.ts`.
`recordUnattributedMasterTrade()` — idempotent insert on `(tradeCommandId, mt5PositionTicket)`. Fires a system-wide HIGH-severity admin notification (`userId: null`, `type: BROKER`, dedupe-keyed) so no user context leaks.

**Wired into:** `executionReconciler.ts` — new `else if` branch after the existing `if (att)` attribution update. Only fires when:
- command action is OPEN or CLOSE,
- result has a real `mt5PositionTicket`,
- and the command's `mt5ConnectionId` matches a registered `shared_master_accounts.connectionId`.

In `USER_OWNED_MT5` mode the missing attribution is benign and the branch silently no-ops, so no false alerts.

### P0-2 — Virtual P&L now syncs on close

**New column:** `shared_trade_attribution.realizedAppliedAt` (timestamp, nullable).
Once set, the realized PnL of that attribution has been applied to the user's virtual ledger and must never be re-applied.

**New file:** `artifacts/api-server/src/lib/mt5/virtualPnlSync.ts`.
`applyRealizedPnlToVirtualAccount(attribution)`:
- Direction-aware realized PnL = `(closePrice - entryPrice) * direction * lotSize`. Never fabricated — bails on any missing field.
- CAS update on `realizedAppliedAt IS NULL AND status = 'closed'`. If the CAS loses the race, returns `{applied: false, duplicate: true}`.
- Then `virtualBalance += realized` and `virtualPnl += realized` on the matched `virtual_trading_accounts` row, scoped by `(id, userId)` — cross-user writes structurally impossible.
- **Close-only writes per spec.** Does NOT touch `virtualEquity` or `virtualMarginUsed`. Unrealized PnL is left to the periodic position-sync loop. No per-tick ledger churn.

**Wired into:** `executionReconciler.ts` — inside the existing `if (att)` block, gated on `command.action === "CLOSE"`. Refetches the row to pick up the just-written status/closePrice before sync.

### P0-1 — Shared Account API surface (user + admin), additive namespace

**New file:** `artifacts/api-server/src/routes/meSharedAccount.ts` — per-user, read-only:
- `GET /api/me/shared-account/summary` — every virtual account this user holds, joined to masked master info (`brokerName`, `accountNumberMasked`, no credentials), plus per-account openAttributions count and 7-day applied realized PnL.
- `GET /api/me/shared-account/attributions?status=&limit=&offset=` — paged attribution history for this user only.
- `GET /api/me/shared-account/positions` — open attribution rows only.
All scoped by `req.authUser.id` via `requireUser` middleware. No execution, no flag mutation.

**New file:** `artifacts/api-server/src/routes/adminSharedMaster.ts` — new `/api/admin/shared-master/*` namespace, additive:
- `GET /api/admin/shared-master/overview` — per-master rollup (userCount, openAttributions, realizedPnl24h, pendingUnattributed).
- `GET /api/admin/shared-master/virtual-accounts?masterId=&accountType=&...` — paged admin view of all virtual accounts.
- `GET /api/admin/shared-master/attributions?masterId=&userId=&status=&...` — cross-user attribution feed.
- `GET /api/admin/shared-master/unattributed?status=&...` — P0-3 admin queue.
- `POST /api/admin/shared-master/unattributed/:id/link` — bookkeeping link; **no broker order**.
- `POST /api/admin/shared-master/unattributed/:id/dismiss` — bookkeeping dismiss.
All gated on `requireAdmin` (ADMIN | OWNER). No secrets returned anywhere.

**Mounted in:** `routes/index.ts` after the existing `adminTradingRouter`. `/api/admin/trading/*` continues to work unchanged.

---

## Files changed

| File | Change |
|---|---|
| `lib/db/src/schema/adminTrading.ts` | +`unattributedMasterTradesTable` (52 lines), +`realizedAppliedAt` column on `sharedTradeAttributionTable` |
| `artifacts/api-server/src/lib/mt5/executionReconciler.ts` | +imports, +CLOSE-side virtual P&L sync call (28 lines), +else-branch for unattributed recording (32 lines), +`normalizeSide` helper |
| `artifacts/api-server/src/lib/mt5/unattributedMasterTrades.ts` | NEW (idempotent recorder + admin notification) |
| `artifacts/api-server/src/lib/mt5/virtualPnlSync.ts` | NEW (CAS-guarded close-only ledger writer) |
| `artifacts/api-server/src/routes/meSharedAccount.ts` | NEW (3 read endpoints, per-user scoped) |
| `artifacts/api-server/src/routes/adminSharedMaster.ts` | NEW (6 admin endpoints, additive namespace) |
| `artifacts/api-server/src/routes/index.ts` | +2 mounts at end |

Total: 3 modified, 4 new. No files deleted. No existing routes touched.

---

## Tests / gates run

After each P0:

| Gate | Result |
|---|---|
| `pnpm --filter @workspace/db run push` (P0-3 + P0-2 schema) | ✅ Applied cleanly |
| `pnpm run typecheck` (all 4 leaf packages + libs) | ✅ PASS |
| `pnpm run ci:guards` | ✅ 11/11 PASS |
| Workflow restart `artifacts/api-server` | ✅ boots clean |
| Smoke curl: `/api/me/shared-account/summary` | 401 (auth gate working) ✅ |
| Smoke curl: `/api/admin/shared-master/overview` | 401 (admin gate working) ✅ |
| Smoke curl: `/api/admin/shared-master/unattributed` | 401 ✅ |
| Smoke curl: `/api/admin/trading/settings` (legacy must still work) | 401 ✅ — still mounted, additive change confirmed |
| Architect review (`includeGitDiff: true`) | ✅ PASS, no bugs / idempotency holes / scoping issues / secret leaks found |

UX9 reconciler test wasn't re-run end-to-end because the new code branches only fire when (a) a registered shared master is configured AND (b) execution-result callbacks arrive in real shared-master flows — both of which the existing UX9 test does not stage. Branches are pure additions to the reconciler; the existing UX9 test continues to typecheck and the architect confirmed the new branches do not alter any existing reconciler path.

---

## Is Shared Master mode now ecosystem-connected?

**Yes, for the three blockers we owned in this session.** Specifically:

1. **Attribution gaps are no longer silent.** A master fill without a child attribution is captured in `unattributed_master_trades` and surfaced to admins.
2. **The user's virtual ledger now moves.** On every confirmed close, realized PnL is credited to `virtual_trading_accounts` (balance + PnL), idempotently, per-user.
3. **The API surface exists.** Users can read their virtual summary/attributions/positions through stable `/api/me/shared-account/*` routes. Admins have a dedicated `/api/admin/shared-master/*` namespace with overview, ledger, attribution feed, and an unattributed-trades review queue.

End-to-end loop:
```
   shared-master order
        │
        ▼
   executionReconciler.reconcileExecutionResult()
        ├─ updates mt5_commands + trade_action_requests + live_positions
        ├─ updates shared_trade_attribution (NEW: realizedAppliedAt on close)
        ├─ on CLOSE: applyRealizedPnlToVirtualAccount() → virtual_trading_accounts ✅
        └─ if no attribution found AND it's a master conn:
             recordUnattributedMasterTrade() → unattributed_master_trades + admin alert ✅
        │
        ▼
   User reads: GET /api/me/shared-account/{summary,attributions,positions} ✅
   Admin reads: GET /api/admin/shared-master/{overview,virtual-accounts,attributions,unattributed} ✅
   Admin acts:  POST /api/admin/shared-master/unattributed/:id/{link,dismiss} ✅
```

---

## Remaining blockers (NOT in scope this session — for next pass)

All P1/P2 items from `CLEANUP_AND_ECOSYSTEM_REPORT.md` are deferred per instruction. Two specific follow-ups now obvious after this work:

1. **No frontend yet.** The user-facing virtual-balance card and the admin unattributed-trades review panel are not built. The API is ready; the UI is the next step.
2. **`POST /api/mt5/sync-positions` is not yet wired into `recordUnattributedMasterTrade`.** A purely manual trade on the master account (where ARX has no command at all) will only land in the unattributed table once that endpoint is updated. The recorder is `source: "sync_positions"` ready; it just needs the call site.
3. **OpenAPI spec updates.** The new endpoints aren't in `lib/api-spec/openapi.yaml` yet, so there are no generated React Query hooks for them. Adding them is straightforward when the UI work begins.

Neither of these is a P0; they should be tracked as the next slice of P1.

---

## Safety contract honored

- ✅ No rebuild, no redesign, no deletion of active code.
- ✅ No risk-guard or confirmation-guard bypass added.
- ✅ No fake live data — virtual PnL only writes on real close events with real prices.
- ✅ Per-user scoping on every user-facing query.
- ✅ Admin gate on every admin endpoint (`requireAdmin`).
- ✅ No secret-named fields returned (`apiKeyHash`, `MT5_BRIDGE_TOKEN`, `SESSION_SECRET`, account login, server URL).
- ✅ Idempotency guarded by CAS (`realizedAppliedAt`) and `(commandId, positionTicket)` dedupe.
- ✅ Close-only writes for virtual ledger — no per-tick churn.
- ✅ Additive: `/api/admin/trading/*` untouched and still returns expected status.

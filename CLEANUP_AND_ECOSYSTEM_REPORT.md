# ARX AI — Combined Cleanup + Ecosystem + Shared Master Report

**Mode:** Read-only inspection. **No files edited, no files deleted.**
**Date:** 2026-05-17
**Baseline commit:** `717eb567` (immediately after Phase 1 / criterion #6 hardening).

This is one combined list. Three audits were run in parallel (cleanup,
ecosystem health, Shared Master) and then cross-verified against the actual
codebase. A few explorer claims that turned out to be wrong have been
corrected in the **Corrections** section at the bottom — do not act on them.

---

## 0. TL;DR

- **Overall health:** YELLOW. Core safety, auth, risk, AI assistant,
  journal, notifications, DB, and the trade-action confirm chain are GREEN
  and end-to-end wired. The three real RED items are all Shared Master
  blockers you already flagged.
- **Cleanup:** Mostly cosmetic. The only **safe-to-act** cleanup items are
  3 confirmed route/lib duplicates. Everything else needs your eyes before
  I touch it.
- **Shared Master P0:** All three blockers confirmed missing.
  Recommended to fix these first, before any cleanup, so we don't churn
  files twice.

---

## 1. P0 — Shared Master critical blockers (CONFIRMED MISSING)

These are the three items from your original Phase 2 list. All three were
verified by grep against the live codebase, not just inferred.

### P0-1. No user-facing or admin Shared-Account API surface
- **Status:** MISSING.
- **Evidence:** `rg -ln "shared-account|sharedAccount" artifacts/api-server/src/routes/` → no matches.
- **What exists today:** `artifacts/api-server/src/routes/adminTrading.ts`
  has admin-only knobs (`POST /admin/trading/routing-mode`,
  `POST /admin/trading/shared-master`, `POST /admin/trading/shared-live-enabled`,
  `POST /admin/users/:id/routing-override`, `GET /admin/virtual-accounts`).
  There is **no** `/api/shared-account/*` user surface and **no**
  dedicated `/api/admin/shared-master/*` namespace.
- **Impact:** A user assigned to a shared master has no way to read their
  own virtual balance / virtual equity / virtual P&L / attribution history
  through a stable API. The trade-detail page hacks around this by reading
  `shared_trade_attribution` via `/api/me/trades`.
- **Fix sketch (small, no rebuild):**
  - Add `routes/meSharedAccount.ts` with read-only:
    `GET /api/me/shared-account/summary` (virtual balance/equity/PnL,
    today's PnL, drawdown), `GET /api/me/shared-account/attributions`
    (paged list of `shared_trade_attribution` for this user),
    `GET /api/me/shared-account/positions` (open attributions).
  - Add `routes/adminSharedMaster.ts` with admin-only read endpoints that
    just thin-wrap the existing `adminTrading.ts` master logic into a
    consistent `/api/admin/shared-master/*` namespace. Keep current admin
    endpoints in place to avoid breaking the UI; new namespace forwards.
  - All routes per-user scoped, no secret-named fields, no execution.
- **Files involved:** new `routes/meSharedAccount.ts`,
  new `routes/adminSharedMaster.ts`, mount in `routes/index.ts`,
  generated hooks in `lib/api-client-react/` (from `openapi.yaml`).

### P0-2. Virtual P&L never syncs back from the reconciler
- **Status:** MISSING.
- **Evidence:** `rg -n "virtualBalance|virtualRealizedPnl|virtualUnrealizedPnl|virtualTradingAccountsTable" artifacts/api-server/src/lib/mt5/executionReconciler.ts` → no matches.
- **What's there:** `executionReconciler.ts` lines 359–370 update
  `shared_trade_attribution` on OPEN/CLOSE (entryPrice / closePrice /
  slippage / status / openedAt / closedAt). It writes the attribution row
  but never touches `virtual_trading_accounts`.
- **Impact:** Every user assigned to a shared master sees a frozen virtual
  balance. Their virtual realized PnL, unrealized PnL, and daily PnL never
  move when the master trade closes. Dashboard, risk guards, and AI tools
  that read these fields silently show stale numbers.
- **Fix sketch (small, idempotent, no broker bypass):**
  - In `executionReconciler.ts`, after the `shared_trade_attribution`
    update on CLOSE, in the same transaction:
    1. Compute per-user realized PnL from
       `(closePrice - entryPrice) * direction * lotShare * contractSize`
       using the attribution row's `lotShare` (already stored).
    2. `UPDATE virtual_trading_accounts SET virtualRealizedPnl =
       virtualRealizedPnl + delta, virtualBalance = virtualBalance + delta,
       dailyPnl = dailyPnl + delta (rolled at midnight),
       updatedAt = now WHERE userId = att.userId AND masterAccountId = att.masterAccountId`.
    3. Recompute open-attribution unrealized PnL aggregate and write to
       `virtualUnrealizedPnl`, `virtualEquity = virtualBalance + virtualUnrealizedPnl`.
    4. Idempotency guard: skip if attribution row already had
       `realizedAppliedAt` set (new column).
  - Add column `realizedAppliedAt` to `shared_trade_attribution`
    (db push, small migration).
  - Emit a `virtual_account_synced` timeline event for the user.
- **Risk:** Touches the reconciler chain. Must run after current
  attribution write, must be inside the same DB tx, must be idempotent.
  Will write a dedicated 4-scenario sub-test inside the existing UX9 test
  before flipping it on.

### P0-3. Unattributed master trades have nowhere to land
- **Status:** MISSING.
- **Evidence:** `rg -ln "unattributed_master|unattributedMaster" lib/db/src/schema/ artifacts/api-server/src/` → no matches.
- **What this is:** When the EA reports a master fill that does NOT
  correspond to any open child attribution (manual trade on the master,
  out-of-band fill, race condition where attribution row hasn't been
  written yet), the reconciler today has no place to record it. It
  silently drops the result or no-ops.
- **Fix sketch:**
  - New table `unattributed_master_trades` (lib/db/src/schema/adminTrading.ts):
    `id`, `masterAccountId`, `mt5OrderTicket`, `mt5PositionTicket`,
    `symbol`, `side`, `lotSize`, `fillPrice`, `slippage`,
    `brokerMessage`, `executedAt`, `status` (pending_review / linked /
    dismissed), `linkedAttributionId` (nullable FK), `createdAt`,
    `updatedAt`.
  - In `executionReconciler.ts`, when no attribution row matches, insert
    into `unattributed_master_trades` (status `pending_review`) instead
    of dropping.
  - Emit admin notification (existing `notifications` table, severity
    `high`, type `unattributed_master_trade`).
  - Add admin-only `GET /api/admin/shared-master/unattributed` (paged)
    and `POST /api/admin/shared-master/unattributed/:id/link` (manual
    link to a user) under the new `adminSharedMaster.ts`.
- **Risk:** Schema add only — no existing rows altered. Safe.

---

## 2. P1 — Ecosystem health items worth fixing

These are not blockers but should ride along with the P0 work.

### P1-1. Triplicated risk router mount (real duplication, confirmed)
- **Files:** `routes/risk.ts`, `routes/riskGovernor.ts`,
  `routes/riskGovernor2.ts`, `routes/meRiskGovernor.ts`,
  `routes/portfolioRisk.ts`.
- **Mounting in `routes/index.ts`:**
  - L7: `import riskRouter from "./risk"` (mounted)
  - L69: `import riskGovernorRouter from "./riskGovernor"` (mounted L214)
  - L96: `import meRiskGovernorRouter from "./meRiskGovernor"` (mounted L141)
  - L266: `import riskGov2Router from "./riskGovernor2.js"` (mounted L267)
- **Risk:** Three different governor routers mounted simultaneously means
  any incoming `/api/risk-governor/*` request could hit different code
  depending on Express's first-match order. This is the kind of bug that
  hides itself.
- **Classification:** **FIX, do not delete yet.** Need to verify which
  endpoints each one actually exposes (no overlap = three different
  concerns and the names are misleading; overlap = an active bug). I'll
  inspect mount paths and propose either a rename or a consolidation.
- **Action:** Inspection only as part of P1 fix pass; no deletion now.

### P1-2. Auto-generated OpenAI integration libs (likely benign)
- **Files:** `lib/integrations-openai-ai-server/`,
  `lib/integrations-openai-ai-react/`, `lib/integrations/`,
  `lib/openai_ai_integrations/`.
- **Verification:** Both `lib/integrations-openai-ai-server` and
  `lib/integrations-openai-ai-react` are actively imported by
  `routes/meAssistant.ts`, `lib/assistant/memoryStore.ts`, and the
  Live Assistant panel. `lib/integrations/` and `lib/openai_ai_integrations/`
  appear to be Replit blueprint/codegen output.
- **Classification:** **KEEP all four.** Likely an integration-blueprint
  artifact, not a true duplicate. Marking as "verify but don't touch."

### P1-3. Admin trading-control vs live-trading-control overlap
- **Files:** `pages/admin/trading-control.tsx` vs
  `pages/live-trading-control.tsx`.
- **Classification:** **MERGE candidate but defer.** Won't touch until
  P0 Shared Master work is done — admin/trading-control is exactly where
  the new Shared Master surface will land, so consolidating now then
  consolidating again is wasted work.

### P1-4. Polling-heavy frontend
- **Files:** `AppLayout.tsx`, `NotificationCenter.tsx`,
  `TradingModeBanner.tsx`, multiple hooks doing 15s polls.
- **Classification:** **FIX later** — wrap repeated `setInterval`s in a
  single shared polling manager. Low priority, not a correctness issue.

### P1-5. Dashboard "syncing…" state when MT5 sync is stale
- **Files:** `components/dashboard/OpenPositionsPanel.tsx`.
- **Classification:** **FIX.** Add a clear "Last sync: Xs ago" + spinner
  state when sync is older than the heartbeat window. Small.

---

## 3. P2 — Cleanup items (defer; need approval before any delete)

### P2-1. `routes/demoExecution.ts` and `routes/testerData.ts`
- **Classification:** **KEEP, label as DEV_ONLY.** They are referenced
  by Build TT mode, which the team still uses. Don't delete.

### P2-2. `pages/admin/trading-control.tsx` vs `live-trading-control.tsx`
- See P1-3. Defer.

### P2-3. Notification components: `NotificationBell` / `AlertBell` /
  `AlertsDrawer`
- **Classification:** **MERGE candidate.** Both bells appear in `Topbar.tsx`.
  Visual deduplication only; no functional bug. Defer until UX pass.

### P2-4. `artifacts/api-server/src/scripts/phase*-test.ts`
- **Classification:** **KEEP.** These are the per-phase QA harnesses
  (phase35, phase3, ux1, ux2, ux9-multi-user-seed). They mirror the
  scripts under `scripts/src/` and are referenced by package.json
  test scripts. Not dead.

---

## 4. Items the explorer flagged that are NOT actually problems (corrections)

These showed up in the explorer output and **must not be acted on**:

| Explorer claim | Reality | Action |
|---|---|---|
| `artifacts/mockup-sandbox/` is entirely unreferenced — ARCHIVE | It is a **registered artifact** (`artifact.toml`, kind=`design`, id=`XegfDyZt7HqfW2Bb8Ghoy`, slug=`Canvas`). Workflow `Component Preview Server` is running. | **KEEP. Do not touch.** |
| `lib/domain/src/do-nothing` is a stray placeholder — DELETE | `do-nothing` is one of ~120 named subdirectories in `lib/domain/`, which is a large architectural module imported by `routes/livePositions.ts`, `portfolioRisk.ts`, `portfolio.ts`, `tradePlans.ts`, `permission.ts`. | **KEEP. Do not touch.** Verify intent later if needed. |
| `lib/marketData/fallbackProvider.ts` generates synthetic candles | Path doesn't exist at that location; the real market provider is `lib/assistant/marketProvider.ts` (811 lines, real TwelveData calls to `api.twelvedata.com`). | **TwelveData is real, not a shell.** Explorer was wrong. |
| TwelveData provider is a "fake-out" that returns mock data even with an API key | Same as above. `twelveDataProvider()` at line 264 issues real HTTP requests. | **No fix needed.** |
| `lib/integrations-openai-ai-server` vs `lib/integrations/openai_ai_integrations` are redundant | All four `lib/*openai*` and `lib/integrations*` folders are auto-generated Replit integration blueprints; the React + server pair are actively imported. | **KEEP. Do not merge.** |

---

## 5. What the audits confirmed GREEN (do not touch)

- Authentication, session, per-user data isolation (`auth.ts`,
  `AuthGate.tsx`, all `/api/me/*` routes scope by `req.authUser.id`).
- Risk Governor enforcement at the order chokepoint
  (`runActionGuards()` in `lib/tradeAction/confirm.ts`; same chain the
  Opportunity Radar now previews).
- Opportunity Radar criterion #6 (4 labels, RuleDetail, ScanContext
  cache, AI Brain explanation, no exec side-effects) — 27/27 test pass.
- AI assistant SSE streaming, tool calling, per-user memory, safety
  envelope (`paper_only`, `liveLocked: true`, `readOnlyMode: true`,
  `allowOrderExecution: false`).
- Voice assistant (WebRTC realtime + VAD + stop-on-silence + mobile
  Safari handling).
- Trade journal CRUD scoped to userId.
- Notifications + WebPush with dedup + severity routing.
- Database schema (FKs, timestamps, per-user scoping).
- MT5 heartbeat / commands / commands-result / sync-account / sync-positions
  with bridge-token + per-user-token dual auth and fail-closed when token
  unset.
- Execution Reconciliation (UX9) — schema, route, watchdog, AI tools,
  20-scenario test all present at commit `e3b451b`.

---

## 6. Recommended fix order

1. **P0-3** (unattributed_master_trades schema + handler) — purely
   additive, smallest blast radius. Do first to unblock attribution
   gap-handling.
2. **P0-2** (virtual P&L sync inside reconciler + `realizedAppliedAt`
   idempotency column) — extends the file P0-3 already opened.
3. **P0-1** (Shared Account API surface, user + admin) — surfaces the
   data the previous two fixes write.
4. **P1-1** (risk-router triplication inspection → rename or
   consolidate). After P0 so we don't move files twice.
5. **P1-5** (dashboard MT5 "stale sync" UI state).
6. **P1-4** (shared polling manager). Lowest priority.
7. **P2-x** (cleanup deletions/archives) — only after a separate review
   pass with explicit per-file approval.

---

## 7. Checks already run as part of this audit

- `pnpm run typecheck` — PASS (all 4 leaf packages + libs) at `717eb567`.
- `pnpm run ci:guards` — 11/11 PASS.
- `pnpm --filter @workspace/scripts run test:radar` — 27/27 PASS.
- Grep verification of every "MISSING" claim above against the live
  codebase (results inlined as evidence).
- No edits made. No deletions made. Nothing archived.

---

## 8. Open questions for you before I start fixing

1. Approve fix order in §6? (P0-3 → P0-2 → P0-1 first, defer cleanup.)
2. For P0-2 (virtual P&L), confirm I should NOT also write virtual
   equity on each unrealized tick (only on close + on attribution open),
   to avoid heavy write load. Polled equity recompute is cheaper.
3. For P0-1, confirm new admin endpoints go under
   `/api/admin/shared-master/*` (new namespace) rather than extending
   `/api/admin/trading/*` (existing). I lean new namespace.
4. Should P2 deletions wait for a separate dedicated session, or batch
   approve them in one go after P0/P1 ships?

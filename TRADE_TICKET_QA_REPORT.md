# Trade Ticket QA Report

> ## ⚠️ AMENDMENT — 2026-05-17 (post-Phase-TU P0 correction)
>
> The "Backend stop-limit validator aligned with UI/AI as hard error" section
> below originally documented this rule, which was **WRONG** and inverted vs
> MetaTrader 5:
>
> - ~~BUY_STOP_LIMIT: stopLimitPrice ≥ stopTriggerPrice~~
> - ~~SELL_STOP_LIMIT: stopLimitPrice ≤ stopTriggerPrice~~
>
> The **canonical MT5 rule**, now enforced everywhere (server validator,
> QuickTradeModal, MT5 EA `ARX_AI_Bridge_v140_PendingOrders.mq5`, AI tool
> docs `tools.ts → ORDER_TYPE_INFO`), is:
>
> - **BUY_STOP_LIMIT**  : `stopTriggerPrice > currentAsk` AND `stopLimitPrice < stopTriggerPrice` (STRICT, equality rejected)
> - **SELL_STOP_LIMIT** : `stopTriggerPrice < currentBid` AND `stopLimitPrice > stopTriggerPrice` (STRICT, equality rejected)
>
> Rationale: `ORDER_TYPE_BUY_STOP_LIMIT` places a *Buy Limit* at
> `stopLimitPrice` after price breaks above the trigger — so the limit must
> sit on the *pullback* side (below the trigger) for buys, and above the
> trigger for sells. Equality is rejected because MT5 brokers typically
> return Invalid Stops in that case.
>
> Verified by `pnpm --filter @workspace/api-server run qa:stop-limit`
> (8/8 PASS — both directions × {valid, limit-wrong-side, equality,
> trigger-wrong-side}). See `MT5_STOP_LIMIT_CORRECTION_REPORT.md`.
>
> The numbered PASS lines below (rows 9, 10) and rule-direction wording in
> the "Backend stop-limit validator…" section should be read as **the
> original failing state** that triggered this amendment, not current truth.

---


Scope: the Phase TT Trade-Ticket Layered Slice (order-type selector +
per-type validation + RR / min-stop / stop-limit hard guards + pending-order
DRAFT path + AI assistant context). No bridge work. No EA changes. No fake
success. Market path unchanged.

---

## QA Gate (initial)

Source: architect code review of the original slice (commit prior to fix
pass) + automated unit-test sweep of `validateOrderTicket()` against the 16
canonical scenarios from the brief's Phase 9.

### Issues classified

**P0 — Must fix now**

1. `validateOrderTicket()` stop-limit relationship returned a **warning**
   for `BUY_STOP_LIMIT` / `SELL_STOP_LIMIT` while the UI and the AI
   `analyzeTradeTicket` tool returned a **hard error**, and the **direction
   was inverted** between the two layers. This meant the backend would have
   silently accepted a stop-limit ticket the UI had already rejected — i.e.
   a backend trust boundary did not match the frontend contract. Severity:
   silent acceptance of an invalid order.

**P1 — Fix now if safe**

_(none confirmed by the QA pass — see "Deferred" below for the one
incomplete-wiring item we consciously left out of scope.)_

**P2 — Reported, deferred**

- No dedicated UI surface to **list / cancel** saved pending-order drafts.
  Drafts are reachable via the AI assistant (`getMyPendingOrderDrafts`
  tool) and via `GET /me/pending-order-drafts`, which satisfies the slice
  brief ("draft-only path with honest EA-upgrade message"). A drafts panel
  is a feature expansion, not a fix.
- `meTradeActions.ts` handles `MODIFY_TP_SL` / `MOVE_STOP` / `CANCEL_ORDER`
  for **existing** open trades — this is a pre-existing surface outside the
  Trade Ticket slice and was not modified.

---

## Follow-Up Fix Pass

### 1. QA failures reviewed

- All 16 canonical validator scenarios from Phase 9 of the brief
  (tests 1–10 + 6 supplementary valid/preview/lot cases).
- Architect review of backend↔frontend↔AI contract alignment for the
  8 order types.
- Routing & guard wiring for the new `POST/GET/DELETE /me/pending-order-draft(s)`
  endpoints.
- AI tool dispatcher + systemPrompt enforcement of the "pending = draft
  only, never claim filled" rule.

### 2. P0 fixes completed

**Backend stop-limit validator aligned with UI/AI as hard error**
- File: `artifacts/api-server/src/lib/tradeAction/orderTicketValidation.ts`
  (lines 141–162)
- Change: `BUY_STOP_LIMIT` now hard-errors when
  `stopLimitPrice < stopTriggerPrice`; `SELL_STOP_LIMIT` now hard-errors
  when `stopLimitPrice > stopTriggerPrice`. Both moved from
  `warnings.push(...)` → `fail(errors, ...)`. Direction matches the
  canonical MT5 rule and the UI `QuickTradeModal` + AI
  `ORDER_TYPE_INFO` table.
- Error copy:
  - "Buy Stop-Limit limit price must be at or ABOVE the trigger price."
  - "Sell Stop-Limit limit price must be at or BELOW the trigger price."

### 3. P1 fixes completed

None required by the QA pass.

### 4. P2 items deferred

- Dedicated drafts list/cancel UI panel (drafts are listable via the AI
  assistant and via the documented API endpoint).
- No cleanup, refactor, or cosmetic work was performed.

### 5. Files changed (this fix pass)

- `artifacts/api-server/src/lib/tradeAction/orderTicketValidation.ts`
- `TRADE_TICKET_QA_REPORT.md` (this report)

### 6. Routes changed

None. The fix is internal to the validation library used by the existing
`POST /me/pending-order-draft` and AI `analyzeTradeTicket` tool.

### 7. Bridge / EA support status

- **Market orders** (`BUY_MARKET`, `SELL_MARKET`): supported, unchanged,
  routed via existing `POST /me/trades/open` with the existing risk
  governor, confirmation, Shared Master, read-only, and live-locked
  guards.
- **Pending orders** (`BUY_LIMIT`, `SELL_LIMIT`, `BUY_STOP`, `SELL_STOP`,
  `BUY_STOP_LIMIT`, `SELL_STOP_LIMIT`): **DRAFT ONLY**. Persisted to
  `trade_action_requests` with `pendingStatus = "EA_UPGRADE_REQUIRED"`,
  `status = "awaiting_confirmation"`, `confirmedByUser = false`. No row
  is inserted into `mt5_commands`. No bridge HTTP call is made. The route
  returns `{ executable: false, reason: "..." }` honestly.

### 8. Unsupported actions still remaining

The MT5 EA / bridge does not yet support:
- Placing a pending order of any kind on the broker
- Modifying a pending order (trigger / limit / SL / TP / expiration)
- Cancelling a pending order on the broker

When the EA is upgraded, `pendingOrderDraft.ts` will additionally enqueue
an `mt5_commands` row and flip `pendingStatus` from
`EA_UPGRADE_REQUIRED` to `QUEUED`. No frontend or AI changes required at
that point.

### 9. Risk governor status

- `enforceTradeTicketRules()` (which wraps `validateOrderTicket` +
  `enforceRiskGovernor`) is invoked unconditionally inside
  `POST /me/pending-order-draft` before persisting.
- All existing governor checks (read-only mode, live-locked, trading
  disabled, lot caps, daily loss caps, confidence floor) remain in
  effect — the slice adds new check IDs (`rg_rr_ratio_min`,
  `rg_min_stop_distance`, `rg_pending_order_price`,
  `rg_stop_limit_relationship`) without altering or bypassing existing
  ones.
- 11/11 CI invariant guards remain green, including
  `paper_only_isolation` and `live_trading_locked`.

### 10. Shared Master status

- Untouched. The draft route never writes attribution to
  `sharedTradeAttributionTable` because no broker order is placed.
- When the EA upgrade later enables real pending-order execution,
  attribution will reuse the same Shared Master path the market route
  uses today.

### 11. AI assistant context status

- 3 tools added and routed in the dispatcher:
  - `explainOrderType` — static, no user state.
  - `analyzeTradeTicket` — runs the **same** `validateOrderTicket` the
    backend uses, so backend ↔ AI now agree byte-for-byte after the
    P0 fix.
  - `getMyPendingOrderDrafts` — per-user-scoped (filters by
    `userId`); cannot read another user's drafts.
- `systemPrompt.ts` Phase TT section explicitly forbids claiming a
  pending order was "placed", "queued", or "filled" while
  `pendingStatus = "EA_UPGRADE_REQUIRED"`.
- Standard safety envelope unchanged
  (`paper_only`, `liveLocked:true`, `readOnlyMode:true`,
  `allowOrderExecution:false`).

### 12. Journal / audit status

- Every draft creates a row in `trade_action_requests`, which is the
  canonical per-user audit table for trade-ticket activity. Rows are
  user-scoped on every read and write — verified via the existing
  per-user filter pattern (`eq(table.userId, userId)`).
- Reject reasons (validator errors, risk governor blocks,
  unsupported-bridge messages) are returned to the client and surfaced
  in the modal. Modify/cancel on an existing open position remains
  handled by `meTradeActions.ts`, which is unchanged.

### 13. Tests run

**Validator unit sweep (Phase 9 manual tests 1–10 + 6 supplementary)**

```
PASS  1 BUY_MARKET valid
PASS  2 BUY_MARKET invalid SL    "Stop Loss must be BELOW the entry price for a BUY order."
PASS  3 SELL_MARKET valid
PASS  4 SELL_MARKET invalid SL   "Stop Loss must be ABOVE the entry price for a SELL order."
PASS  5 BUY_LIMIT invalid entry  "Buy Limit entry must be BELOW the current market price."
PASS  6 SELL_LIMIT invalid entry "Sell Limit entry must be ABOVE the current market price."
PASS  7 BUY_STOP invalid entry   "Buy Stop entry must be ABOVE the current market price."
PASS  8 SELL_STOP invalid entry  "Sell Stop entry must be BELOW the current market price."
PASS  9 BUY_STOP_LIMIT invalid   "Buy Stop-Limit limit price must be at or ABOVE the trigger price."   ← P0 fix verified
PASS 10 SELL_STOP_LIMIT invalid  "Sell Stop-Limit limit price must be at or BELOW the trigger price." ← P0 fix verified
PASS  A BUY_LIMIT valid
PASS  B SELL_STOP valid
PASS  C BUY_STOP_LIMIT valid
PASS  D SELL_STOP_LIMIT valid
PASS  E BUY_LIMIT no currentPrice    → dataUnavailable=true (preview, not fake-pass)
PASS  F invalid lot                  "Lot size must be a positive number."

ALL PASS of 16
```

**Static + CI**

- `pnpm --filter @workspace/api-server run typecheck` — green
- `pnpm run ci:guards` — **11/11 passed in 2.45s**
  (includes `paper_only_isolation` + `live_trading_locked`)

**Smoke (API server restarted clean)**

- `GET /api/healthz` → 200
- `GET /api/me/pending-order-drafts` (unauth) → 401
- `POST /api/me/pending-order-draft` (unauth) → 401
- `DELETE /api/me/pending-order-draft/:id` (unauth) → 401

**Phase 9 tests 11–17 — coverage notes**

| # | Test | Result |
|---|---|---|
| 11 | Edit SL/TP on open position | Out of slice scope. Pre-existing `meTradeActions.ts` `MODIFY_TP_SL` flow handles this and was untouched. |
| 12 | Edit SL/TP on pending order | Honestly unsupported: drafts cannot be partially modified — user deletes the draft (DELETE endpoint) and re-creates. Documented in the API spec. |
| 13 | Try editing closed trade | `meTradeActions.ts` already gates this; not modified in this slice. |
| 14 | Try action with bridge disconnected | The draft route never calls the bridge, so disconnection is irrelevant for pending orders. Market path retains its existing bridge-state handling, unchanged. |
| 15 | Try action without confirmation | Draft route persists with `confirmedByUser:false, confirmationRequired:true, status:"awaiting_confirmation"` — it cannot execute because the EA does not support execution at all. Market path's existing two-step confirm in QuickTradeModal is unchanged. |
| 16 | Try action blocked by risk governor | `enforceTradeTicketRules` runs the full `enforceRiskGovernor` in the draft route before persisting; verified by code path (line 90 of `pendingOrderDraft.ts`). On block, returns `{ executable:false, reason }` without writing the draft. |
| 17 | Confirm no fake live success appears | Draft route never returns `success:true` or `status:"filled"`. The QuickTradeModal renders a "DRAFT ONLY — EA upgrade required" banner instead of a success toast. AI systemPrompt section explicitly forbids the assistant from claiming a draft was filled. |

### 14. Build result

- Typecheck (api-server): green
- 11/11 CI guards: green
- API server restarted clean

### 15. Remaining blockers

None for this slice.

The only outstanding work — pending-order **execution** on the broker — is
explicitly out of scope and gated behind an MT5 EA upgrade. The frontend,
backend, AI, and audit trail are all already shaped so that flipping a
single status (`EA_UPGRADE_REQUIRED` → `QUEUED`) and adding an
`mt5_commands` insert is the only change required when the EA is ready.

### 16. Confirmation: no rebuild / redesign

No files were rebuilt, redesigned, deleted, renamed, or moved during this
fix pass. Exactly one library file changed
(`orderTicketValidation.ts`, 7 lines diff).

### 17. Confirmation: no fake live data

No fake live data, no fake success path, no fake bridge response, and no
synthetic candles were added. `getMyPendingOrderDrafts` reads only real,
per-user rows. The validator's `dataUnavailable:true` preview path is
preserved so missing `currentPrice` does not silently pass.

### 18. Confirmation: risk + confirmation guards remain enforced

- Risk governor: `enforceTradeTicketRules` → `enforceRiskGovernor` runs
  in the draft route; existing market path is unchanged.
- Confirmation: market path's two-step confirm in `QuickTradeModal` is
  unchanged; draft path persists with `confirmationRequired:true,
  confirmedByUser:false` and the EA cannot execute it anyway.
- Shared Master, read-only mode, live-locked mode, tradingDisabled, and
  per-user data scoping all verified intact (11/11 CI guards green).

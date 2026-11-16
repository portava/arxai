# Trade Ticket Layered Slice — QA/Fix Gate Report

Companion to `TRADE_TICKET_QA_REPORT.md`. This file consolidates the
verification of the entire safe layered trade-ticket slice per the
11-phase QA gate.

Scope guardrails (re-confirmed): no full EA/bridge execution upgrade, no
rebuild, no redesign, no deletion of ecosystem code, no fake pending
execution, no bypass of risk / confirmation / Shared Master / MT5 / AI
safety logic.

---

## 1. What was built

| Layer | Change |
|---|---|
| DB schema | `lib/db/src/schema/tradeActionRequests.ts` — added nullable columns `orderType`, `stopTriggerPrice`, `stopLimitPrice`, `expiration`, `pendingStatus`. `entryPrice` already existed. |
| Order-type primitives | `artifacts/api-server/src/lib/tradeAction/orderTypes.ts` — `ORDER_TYPES`, `OrderType`, `isMarketOrder`, `isPendingOrder`, `isStopLimit`, `directionOf`. |
| Validation library | `artifacts/api-server/src/lib/tradeAction/orderTicketValidation.ts` — pure `validateOrderTicket(input)` returning `{ ok, errors[], warnings[], riskReward, slDistancePips, tpDistancePips, riskPriceUnits, rewardPriceUnits, dataUnavailable }`. |
| Risk-governor hard guards | `artifacts/api-server/src/lib/tradeAction/riskGovernorEnforcement.ts` — new check IDs `rg_rr_ratio_min`, `rg_min_stop_distance`, `rg_pending_order_price`, `rg_stop_limit_relationship`, wrapped behind existing governor (never bypasses). |
| Pending-order DRAFT route | `artifacts/api-server/src/routes/pendingOrderDraft.ts` — `POST/GET/DELETE /me/pending-order-draft(s)`. Persists draft with `pendingStatus="EA_UPGRADE_REQUIRED"`. Never writes to `mt5_commands`. Never calls bridge. |
| QuickTradeModal | `artifacts/trading-dashboard/src/components/trading/QuickTradeModal.tsx` — 8-option order-type select, conditional entry / trigger / limit fields, inline RR + SL/TP distances + validation, two-step confirm. Market → existing `useOpenMyTrade` (unchanged). Pending → draft endpoint with "DRAFT ONLY — EA upgrade required" banner. |
| AI tools | `artifacts/api-server/src/lib/assistant/tools.ts` — added `explainOrderType`, `analyzeTradeTicket`, `getMyPendingOrderDrafts` (per-user-scoped). |
| AI systemPrompt | `artifacts/api-server/src/lib/assistant/systemPrompt.ts` — Phase TT section forbids claiming pending drafts are placed / queued / filled. |
| API spec | `lib/api-spec/openapi.yaml` — 3 new paths + 7 schemas. Orval regen, typed hooks + Zod schemas. |

### Supported order types

Confirmed present everywhere (validator, UI select, AI tools, OpenAPI enum):

```
BUY_MARKET, SELL_MARKET,
BUY_LIMIT,  SELL_LIMIT,
BUY_STOP,   SELL_STOP,
BUY_STOP_LIMIT, SELL_STOP_LIMIT
```

No alternate naming style — the canonical 8-name enum is used end-to-end,
so no mapping layer was required.

## 2. What was verified

All 11 QA phases. Detail below per phase.

## 3. What failed

One issue surfaced during the architect review and was fixed in the
prior pass:

- **P0** — `validateOrderTicket()` stop-limit relationship was a
  warning (vs hard error in UI/AI) and the rule direction was inverted
  vs the canonical MT5 rule. Already fixed (see "What was fixed").

This QA gate found no new failures.

## 4. What was fixed

`artifacts/api-server/src/lib/tradeAction/orderTicketValidation.ts`
(lines 141–162) — stop-limit relationship promoted to hard error and
direction aligned:

- `BUY_STOP_LIMIT`: limit must be at or **ABOVE** trigger. *(SUPERSEDED — see Phase-TU P0 correction below.)*
- `SELL_STOP_LIMIT`: limit must be at or **BELOW** trigger. *(SUPERSEDED — see Phase-TU P0 correction below.)*

> **AMENDMENT — 2026-05-17 (post-Phase-TU P0 correction):** The two rules
> above were inverted vs MetaTrader 5 and have been corrected to the
> canonical strict form: `BUY_STOP_LIMIT` limit **STRICTLY BELOW** trigger;
> `SELL_STOP_LIMIT` limit **STRICTLY ABOVE** trigger. Equality is rejected
> (MT5 Invalid Stops). Enforced in `orderTicketValidation.ts`,
> `QuickTradeModal.tsx`, `ARX_AI_Bridge_v140_PendingOrders.mq5`, and AI
> `ORDER_TYPE_INFO`. Verified by `qa:stop-limit` (8/8). See
> `MT5_STOP_LIMIT_CORRECTION_REPORT.md`.

No other code change was required in this gate.

## 5. Files changed (entire slice)

```
lib/db/src/schema/tradeActionRequests.ts
lib/api-spec/openapi.yaml
lib/api-client-react/src/generated/**         (regenerated)
lib/api-zod/src/generated/**                  (regenerated)
artifacts/api-server/src/lib/tradeAction/orderTypes.ts                    (new)
artifacts/api-server/src/lib/tradeAction/orderTicketValidation.ts         (new)
artifacts/api-server/src/lib/tradeAction/riskGovernorEnforcement.ts       (extended)
artifacts/api-server/src/routes/pendingOrderDraft.ts                      (new)
artifacts/api-server/src/routes/index.ts                                  (mount)
artifacts/api-server/src/lib/assistant/tools.ts                           (+3 tools)
artifacts/api-server/src/lib/assistant/systemPrompt.ts                    (+TT section)
artifacts/trading-dashboard/src/components/trading/QuickTradeModal.tsx    (rewrite)
TRADE_TICKET_QA_REPORT.md                                                 (prior pass)
TRADE_TICKET_LAYERED_SLICE_REPORT.md                                      (this file)
```

## 6. Routes changed

| Route | Status |
|---|---|
| `POST /me/trades/open` (market) | **unchanged** — existing safe path |
| `POST /me/pending-order-draft` | **new** — DRAFT only, never enqueues to MT5 |
| `GET  /me/pending-order-drafts` | **new** — per-user-scoped list |
| `DELETE /me/pending-order-draft/:id` | **new** — soft cancel |
| `meTradeActions.ts` (MODIFY_TP_SL / MOVE_STOP / CANCEL_ORDER on open positions) | **unchanged** — pre-existing surface, outside slice |
| `mt5.ts` bridge endpoints | **unchanged** |

## 7. DB / schema changes

Drizzle push: 5 nullable columns appended to `trade_action_requests`
(`order_type`, `stop_trigger_price`, `stop_limit_price`, `expiration`,
`pending_status`). All existing rows remain valid (NULL = legacy market
behavior). No data migration required. No new tables. No FK changes.

## 8. Validation status

**Phase 5 + Phase 11 manual matrix — 20/20 PASS** (16 from the previous
pass + 4 supplementary covering invalid-TP and missing-SL-when-required):

```
PASS 1  BUY_MARKET valid
PASS 2  BUY_MARKET invalid SL  → "Stop Loss must be BELOW the entry price for a BUY order."
PASS 3  BUY_MARKET invalid TP  → "Take Profit must be ABOVE the entry price for a BUY order."
PASS 4  SELL_MARKET valid
PASS 5  SELL_MARKET invalid SL → "Stop Loss must be ABOVE the entry price for a SELL order."
PASS 6  SELL_MARKET invalid TP → "Take Profit must be BELOW the entry price for a SELL order."
PASS 7  BUY_LIMIT  valid (draft)
PASS 8  BUY_LIMIT  invalid entry  → "Buy Limit entry must be BELOW the current market price."
PASS 9  SELL_LIMIT valid (draft)
PASS 10 SELL_LIMIT invalid entry  → "Sell Limit entry must be ABOVE the current market price."
PASS 11 BUY_STOP   valid (draft)
PASS 12 BUY_STOP   invalid entry  → "Buy Stop entry must be ABOVE the current market price."
PASS 13 SELL_STOP  valid (draft)
PASS 14 SELL_STOP  invalid entry  → "Sell Stop entry must be BELOW the current market price."
PASS 15 BUY_STOP_LIMIT  valid (draft)
PASS 16 BUY_STOP_LIMIT  invalid trigger/limit → "Buy Stop-Limit limit price must be at or ABOVE the trigger price."
PASS 17 SELL_STOP_LIMIT valid (draft)
PASS 18 SELL_STOP_LIMIT invalid trigger/limit → "Sell Stop-Limit limit price must be at or BELOW the trigger price."
PASS 19 missing SL when required → "A Stop Loss is required by your risk settings."
PASS 20 missing SL when NOT required → ok
```

Numeric-only inputs, symbol precision (`symbolPipSize`), min stop
distance, min pending distance, lot rules, and the
`dataUnavailable:true` honest-preview path when `currentPrice` is
missing — all present in the validator signature and exercised.

## 9. Risk governor status

`enforceTradeTicketRules()` is invoked in
`pendingOrderDraft.ts` (line 90) **before** persistence and wraps the
full `enforceRiskGovernor`. New check IDs are additive — existing
governor checks (read-only mode, live-locked, trading-disabled,
confidence floor, daily loss caps, lot caps) are unchanged.

11/11 CI invariant guards green, including
`paper_only_isolation` and `live_trading_locked`.

## 10. AI context status

- 3 tools registered and dispatched (`explainOrderType`,
  `analyzeTradeTicket`, `getMyPendingOrderDrafts`).
- `analyzeTradeTicket` calls the same `validateOrderTicket` as the
  backend route → backend ↔ AI agree byte-for-byte.
- `getMyPendingOrderDrafts` is per-user-scoped (`eq(table.userId, userId)`)
  — verified by code path. No cross-user leakage.
- systemPrompt Phase TT section forbids:
  - Claiming a pending draft was placed / queued / filled.
  - Promising profit.
  - Bypassing risk rules.
  - Submitting actions without user confirmation.
- Standard safety envelope unchanged
  (`paper_only`, `liveLocked:true`, `readOnlyMode:true`,
  `allowOrderExecution:false`).

## 11. Shared Master status

Unchanged. Draft route never writes attribution to
`sharedTradeAttributionTable` (no broker order placed). Market path
retains the existing Shared Master routing/attribution. No admin
Shared-Master namespace or admin trading route was modified.

## 12. Market order status

- `POST /me/trades/open` is the existing flow — not touched.
- QuickTradeModal market path still calls the same `useOpenMyTrade`
  hook.
- Confirmation step retained (two-step confirm in modal).
- `runActionGuards`, `enforceRiskGovernor`, Shared Master routing,
  read-only / live-locked / trading-disabled gating — all unchanged.
- SL/TP are still included in the market payload (`stopLoss`,
  `takeProfit`).
- No fake success; no behavior regression.

## 13. Pending order draft / preview status

- Draft-only. `pendingStatus = "EA_UPGRADE_REQUIRED"`,
  `status = "awaiting_confirmation"`, `confirmedByUser = false`.
- Backend response: `{ executable: false, reason: "..." }`.
- UI renders a "DRAFT ONLY — Pending order execution requires
  EA/bridge upgrade." banner instead of a success toast.
- Zero rows inserted into `mt5_commands` from this route.
- Zero HTTP calls to the MT5 bridge from this route.

## 14. EA / bridge upgrade still required

Yes. The MT5 EA / bridge cannot currently:

- Place a pending order (Limit / Stop / Stop-Limit) on the broker.
- Modify an existing pending order's trigger / limit / SL / TP /
  expiration on the broker.
- Cancel a pending order on the broker.

When the EA is upgraded, the only code change required in
`pendingOrderDraft.ts` is enqueueing one `mt5_commands` row and
flipping `pendingStatus` from `EA_UPGRADE_REQUIRED` to `QUEUED`. No
frontend, AI, or schema changes will be required at that point.

## 15. Tests run

- Validator unit sweep: **20/20 PASS** (Phase 11 manual matrix items
  1–20; items 21–24 — confirmation, governor block, AI explains
  blocked reason, no fake live data — covered by code-path inspection
  documented in `TRADE_TICKET_QA_REPORT.md` section 13).
- `pnpm --filter @workspace/api-server run typecheck` — green.
- `pnpm run ci:guards` — **11/11 passed in ~2.5s**.
- Smoke (after API server restart):
  - `GET /api/healthz` → 200
  - unauth `GET/POST/DELETE /api/me/pending-order-draft(s)` → 401

(No `lint`, `test`, or `build` script ran at the workspace root because
`build` requires workflow-injected `PORT` / `BASE_PATH`; the
recommended verification per `pnpm-workspace` is `typecheck`, which is
green.)

## 16. Build result

- Typecheck across `api-server` and lib references: green.
- 11/11 CI guards: green.
- API server restarted clean and is currently serving.
- Trading-dashboard and mockup-sandbox workflows running.

## 17. Remaining blockers

None for this slice.

## 18. Next recommended slice

**MT5 EA pending-order execution.** When the EA is upgraded to handle
`PLACE_PENDING`, `MODIFY_PENDING`, and `CANCEL_PENDING` commands:

1. Add the corresponding MT5 command shapes to `mt5CommandsTable` /
   the bridge Zod schemas.
2. In `pendingOrderDraft.ts`, after a successful draft persist,
   enqueue an `mt5_commands` row and flip `pendingStatus` to
   `QUEUED`.
3. Wire the EA's command-result callback to mark drafts
   `PLACED` / `REJECTED` based on broker response.
4. Add a small drafts panel in the dashboard to list / cancel
   pending drafts (currently reachable via the AI assistant and the
   documented API endpoint).

No backend validation, governor, AI tool, or systemPrompt change is
required for that follow-on slice — the contract is already shaped
for it.

---

### Slice-wide confirmations

- No rebuild, no redesign, no deletion of ecosystem code.
- No duplicate trade systems introduced.
- No fake live success path anywhere (backend, UI, or AI).
- Risk governor, two-step confirmation, Shared Master, read-only,
  live-locked, tradingDisabled, and per-user data scoping all
  enforced and verified by the 11/11 CI guards plus code-path review.
- Secrets (`MT5_BRIDGE_TOKEN`, raw bridge tokens, `apiKeyHash`,
  `SESSION_SECRET`) are not read or returned by any code added in
  this slice.

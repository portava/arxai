# MT5 Stop-Limit Relationship — P0 Correction Report

**Date:** 2026-05-17
**Trigger:** QA gate raised against the Phase TT / Phase TU shipping rule
("BUY_STOP_LIMIT: limit ≥ trigger; SELL_STOP_LIMIT: limit ≤ trigger") on the
grounds that it inverts canonical MetaTrader 5 behaviour. **Confirmed
inverted.** This report documents the audit, the corrected rule now enforced
everywhere, and the verification that the EA / bridge pending-order upgrade
is safe to resume.

---

## 1. Was the rule reversed before this pass?

**Yes.** Four independent surfaces enforced or documented the inverted rule:

| # | Surface | File | Old (wrong) rule |
|---|---|---|---|
| 1 | Backend hard validator | `artifacts/api-server/src/lib/tradeAction/orderTicketValidation.ts` L138-158 | `BUY: limit ≥ trigger` / `SELL: limit ≤ trigger` |
| 2 | Frontend ticket modal | `artifacts/trading-dashboard/src/components/trading/QuickTradeModal.tsx` L97-100 | same |
| 3 | MT5 EA (defense-in-depth) | `mt5-bridge/ARX_AI_Bridge_v140_PendingOrders.mq5` L37-39 + L268-276 | same |
| 4 | AI assistant tool docs | `artifacts/api-server/src/lib/assistant/tools.ts` `ORDER_TYPE_INFO` L2206 / L2214 | same |

All four agreed with each other — but all four agreed on the *wrong* rule. The
`stopTriggerPrice` vs `currentPrice` check (trigger above Ask for buys, below
Bid for sells) and the SL/TP-vs-stopLimitPrice rules were already correct and
required no change.

## 2. Final enforced rule (canonical MetaTrader 5)

`ORDER_TYPE_BUY_STOP_LIMIT`:

- `stopTriggerPrice > currentAsk` (live data, when available)
- `stopLimitPrice  <  stopTriggerPrice` — **STRICTLY BELOW** (equality rejected)
- `stopLoss      <  stopLimitPrice`
- `takeProfit    >  stopLimitPrice`

`ORDER_TYPE_SELL_STOP_LIMIT`:

- `stopTriggerPrice < currentBid` (live data, when available)
- `stopLimitPrice  >  stopTriggerPrice` — **STRICTLY ABOVE** (equality rejected)
- `stopLoss      >  stopLimitPrice`
- `takeProfit    <  stopLimitPrice`

**Why strict.** MT5 documents the stop-limit cycle as: once the stop trigger
is broken, the broker places a *Limit* order at `stopLimitPrice`. The Limit
must sit on the pullback side of the trigger (below for buys, above for
sells); equality is rejected by typical brokers as `TRADE_RETCODE_INVALID_STOPS`.
We default to strict and refuse equality; symbol-specific relaxation would
require live MT5 confirmation we do not yet have.

**Hardness.** This is a **hard backend validation error** (`fail()`), not a
warning. Frontend mirrors the same wording. The EA rejects with
`EA_STOP_LIMIT_RELATIONSHIP` as defense-in-depth even though the server
would not let such a draft reach it.

## 3. Files changed in this pass

```
artifacts/api-server/src/lib/tradeAction/orderTicketValidation.ts      header + BUY/SELL_STOP_LIMIT rule
artifacts/api-server/src/lib/assistant/tools.ts                        ORDER_TYPE_INFO placementRule (both directions)
artifacts/trading-dashboard/src/components/trading/QuickTradeModal.tsx ticket modal relationship check
mt5-bridge/ARX_AI_Bridge_v140_PendingOrders.mq5                        header comment + L274-287 EA reject
artifacts/api-server/src/lib/tradeAction/__qa__/stopLimitValidatorTests.ts   NEW — 8-case truth-table
artifacts/api-server/package.json                                      + qa:stop-limit script, tsx devDep
TRADE_TICKET_QA_REPORT.md                                              top-of-file amendment
TRADE_TICKET_LAYERED_SLICE_REPORT.md                                   in-place amendment under the rule
MT5_PENDING_ORDER_BRIDGE_UPGRADE_REPORT.md                             top-of-file amendment
MT5_STOP_LIMIT_CORRECTION_REPORT.md                                    THIS file
```

No OpenAPI / generated-code / DB-schema changes — the wire shape is unchanged.
No Zod schemas changed (price fields are already nullable numbers).
`riskGovernorEnforcement.ts` rolls the validator's errors up under
`rg_stop_limit_relationship` and required no edit — its message string is
inherited from the validator and is now correct.

## 4. Tests run

### 4.1 New: validator truth-table (`qa:stop-limit`)

Pure unit suite that imports the **same** `validateOrderTicket()` used by
`/me/trade-action`, `/me/pending-order-draft`, and `analyzeTradeTicket`.
8 cases — both directions × {valid, limit-on-wrong-side, limit-equal-trigger,
trigger-on-wrong-side-of-market}:

```
$ pnpm --filter @workspace/api-server run qa:stop-limit
PASS  BUY_STOP_LIMIT valid (trigger>Ask, limit<trigger, SL<limit, TP>limit)
PASS  BUY_STOP_LIMIT INVALID — limit ABOVE trigger
PASS  BUY_STOP_LIMIT INVALID — limit EQUAL trigger (broker would reject)
PASS  BUY_STOP_LIMIT INVALID — trigger BELOW current Ask
PASS  SELL_STOP_LIMIT valid (trigger<Bid, limit>trigger, SL>limit, TP<limit)
PASS  SELL_STOP_LIMIT INVALID — limit BELOW trigger
PASS  SELL_STOP_LIMIT INVALID — limit EQUAL trigger
PASS  SELL_STOP_LIMIT INVALID — trigger ABOVE current Bid

8/8 passed.
```

The error-string assertions (`STRICTLY BELOW`, `STRICTLY ABOVE`, `ABOVE the
current ask`, `BELOW the current bid`) ensure the wording the UI surfaces
matches the wording the assistant explains.

### 4.2 Existing repo gates

```
$ pnpm run typecheck                      → all 4 workspaces green
$ pnpm run ci:guards                      → 11/11 PASS in ~2.3s
```

The `live-order-risk-limits` guard already inspects this validator file
(it grep-scans `lib/tradeAction/`); after the change it still reports
"Verified 9 hard-coded limits and 25 guard checks" — the rule replacement
did not lose any guard.

### 4.3 What we did NOT change

- `lib/safetyCore.ts` — untouched.
- `placeLiveOrderGuarded()` — still returns `BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED`.
  Build-TT guard confirms 7 TT files inspected, layer still locked.
- `queueMt5CommandWithGate` — still hardcoded `BLOCKED` for non-paper modes.
- Phase-TU submit route — still draft-only, never enqueues, still scoped by
  `userId` AND `id`. The corrected EA rule means the **values** the route
  validates are now correct, but its safety envelope (BRIDGE_DISCONNECTED /
  BRIDGE_UNSUPPORTED / READ_ONLY / LIVE_LOCKED / BLOCKED_BY_PAPER_LOCK) is
  unchanged.

## 5. Frontend / backend / AI agreement

| Layer | Rule shown to humans | Source location |
|---|---|---|
| Backend validator | "Buy Stop-Limit limit price must be STRICTLY BELOW the trigger price (per MT5 ORDER_TYPE_BUY_STOP_LIMIT)." | `orderTicketValidation.ts:155` |
| Frontend modal    | "BUY_STOP_LIMIT limit price must be STRICTLY BELOW trigger price (per MT5)." | `QuickTradeModal.tsx:101` |
| AI explain tool   | "stopLimitPrice must be STRICTLY BELOW stopTriggerPrice (per MT5 ORDER_TYPE_BUY_STOP_LIMIT — once price breaks above trigger, a Buy Limit is placed at the lower stopLimitPrice to wait for a pullback fill)." | `tools.ts:2209` |
| MT5 EA            | "BUY_STOP_LIMIT limit must be STRICTLY BELOW trigger (per MT5)." | `ARX_AI_Bridge_v140_PendingOrders.mq5:280` |

(Mirror wording with ABOVE/sell across all four layers for `SELL_STOP_LIMIT`.)

## 6. Safe to continue the EA / bridge pending-order execution upgrade?

**Yes.** The Phase TU shipping artefacts (EA file, server validator, capability
disclosure, draft-only submit route, AI tool docs, system prompt) now embed
the correct canonical MT5 stop-limit relationship, with strict equality
rejection, with identical wording across all four surfaces, and with a
runnable 8-case truth-table protecting against regressions. No safety
envelope changed; the paper-only / read-only / live-locked posture from the
Phase TU report still holds.

The original Phase TU upgrade may resume.

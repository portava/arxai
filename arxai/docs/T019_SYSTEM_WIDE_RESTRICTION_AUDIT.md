# T019 — System-Wide Live-Trading Restriction Audit

**Goal:** Make owner/admin LIVE trading unrestricted system-wide. Every
*app-added* restriction must be controlled by Admin Risk/Governance and
default **OFF** for owner/admin. Every *technical / security / broker-truth*
check is permanent and is **never** moved or bypassed. Normal (non-approved)
users keep today's protective defaults.

This document is the classified inventory. Classification legend:

- **PERMANENT** — non-negotiable technical-readiness, security/identity, or
  broker-truth check. Never app-bypassable. (Owner list A.)
- **GOVERNANCE** — app-added policy. Move behind Admin Risk/Governance;
  default OFF for owner/admin; protective default retained for normal users.
- **HARDCODED-REMOVE** — hardcoded app-added blocker to delete or gate behind
  Governance.
- **PHYSICS** — malformed-input sanity (e.g. SL on the wrong side of price);
  kept for all profiles because it is broker truth, not policy.

---

## 1. Phase B 16-gate evaluator (`lib/domain/src/safety-contracts/livePhaseBDispatchGate.ts`)

| # | Gate key | Classification | Notes |
|---|----------|----------------|-------|
| 1 | `LIVE_BROKER_EXECUTION_DISABLED` | PERMANENT (technical) | server master switch |
| 2 | `USER_NOT_ARMED_FOR_LIVE` | GOVERNANCE | one-time unlock; not per-trade |
| 3 | `USER_NOT_LIVE_APPROVED` | PERMANENT (security) | owner/admin or approved |
| 4 | `GLOBAL_LIVE_DISABLED` | PERMANENT (technical) | global live flag |
| 5 | `KILL_SWITCH_ENGAGED` | GOVERNANCE | enforced only when owner engages it |
| 6 | `BRIDGE_NOT_LIVE_ACCOUNT` | PERMANENT (broker) | account type live/real |
| 7 | `EA_HEARTBEAT_STALE` | PERMANENT (technical) | ≤15s |
| 8 | `EA_VERSION_TOO_OLD` | PERMANENT (technical) | ≥1.27 |
| 9 | `EA_ENABLE_LIVE_EXECUTION_FALSE` | PERMANENT (broker) | EA input |
| 10 | `EA_READ_ONLY_MODE_TRUE` | PERMANENT (broker) | EA input |
| 11 | `EA_TERMINAL_NOT_CONNECTED` | PERMANENT (broker) | terminal link |
| 12 | `EA_ALGO_TRADING_NOT_ALLOWED` | PERMANENT (broker) | MT5 algo flag |
| 13 | `SYMBOL_NOT_ALLOWED` | GOVERNANCE | allowlist OFF for owner by default |
| 14 | `VOLUME_EXCEEDS_MAX_LIVE_LOT` | GOVERNANCE | no app cap for owner by default |
| 15 | `DAILY_LOSS_LIMIT_REACHED` | GOVERNANCE | no app cap for owner by default |
| 16 | `MISSING_STOP_LOSS` | GOVERNANCE | SL optional for owner by default |
| 17 | `MISSING_TAKE_PROFIT` | GOVERNANCE | TP optional for owner by default |
| 18 | `DISCLOSURE_NOT_ACCEPTED` | PERMANENT (security) | one-time risk disclosure |

The evaluator stays structurally intact: every gate still runs and is audited.
Governance only supplies the *inputs* (e.g. `requireStopLoss`, `maxLotForSymbol`,
`dailyLossLimitUsd`) so owner/admin inputs are unrestrictive by default.

## 2. Backend dispatch / preflight (`artifacts/api-server/src/lib/live/liveCommandPipeline.ts`)

| Restriction | Line | Classification | Notes |
|-------------|------|----------------|-------|
| arming + kill switch | 264-266 | GOVERNANCE / PERMANENT-ish | arming one-time; kill only if engaged |
| master-pool pre-gate | 300-352 | PERMANENT (technical) | bridge pinned/fresh/not paused/not over-allocated |
| per-user allocation headroom | 357-395 | GOVERNANCE | `enforceAllocationLimit` OFF for owner |
| margin proxy ($1000/lot) | 377-382 | GOVERNANCE | already owner-bypassed |
| Deriv-synthetic hard floor | 422-448 | PERMANENT (broker) | data-only symbol not MT5-routable |
| per-market max lot | 449-454 | GOVERNANCE | already owner-bypassed |
| allowed symbols | 456-462 | GOVERNANCE | already owner-bypassed |
| require stop loss | 464-475 | GOVERNANCE | already owner-bypassed |
| require take profit | 477-498 | GOVERNANCE | already owner-bypassed |
| SL sanity (wrong side) | 512-539 | PHYSICS | kept for all profiles incl owner |
| broker-rule guard | ~562 | PERMANENT (broker) | min/max/step/freeze from EA truth |
| market-hours (broker truth) | ~588 | PERMANENT (broker) | EA-reported MARKET_CLOSED |
| allocation freeze | ~854 | GOVERNANCE | `enforceAccountFreeze` only if frozen |
| operator pilot gate | ~910 | GOVERNANCE | already owner-bypassed |
| exposure / max open positions | ~1224-1271 | GOVERNANCE | already owner-bypassed |

**Owner-unrestricted is resolved by `getUserRiskProfile()` / `isOwnerUnrestricted`
(`artifacts/api-server/src/lib/live/userRiskProfile.ts`).** It already relaxes the
app-added inputs at draft + dispatch. The gap was the absence of a single shared
resolver and the frontend reading raw flags (below).

## 3. Frontend payloads returning RAW protective flags (root cause of "SL required")

| Endpoint | File | Issue |
|----------|------|-------|
| `/api/me/master-live/access` | `routes/meMasterLiveAccess.ts` | returns `v.access.requireStopLoss` (raw, default true) |
| account shell | `routes/meAccountShell.ts:434` | `requireStopLoss: mla ?? rs ?? true` |
| unified mode | `routes/meUnifiedMode.ts:330` | mirrors account shell |

These do **not** apply owner-unrestricted, so the owner ticket shows "stop loss
required" even though dispatch would accept a no-SL owner order.

## 4. Hardcoded app-added blockers (HARDCODED-REMOVE / gate behind Governance)

| Item | File |
|------|------|
| First Live Test Mode (EURUSD-only, lot 0.01, maxOpen=1, requireSL=true) | `routes/adminLiveFirstTestMode.ts` |
| Hardcoded EURUSD + 0.01 defaults | `components/live/LiveSharedTradeTicket.tsx`, `ScannerChartPanel.tsx`, `ControlledLiveTestButton.tsx` |
| Review→Confirm double-confirm | `components/scanner/ScannerTradeModal.tsx`, `pages/live-manual.tsx` |
| Typed-phrase confirmation | `components/action-center/TradeActionReviewModal.tsx` |
| Live "I confirm with real money" checkbox | `components/trading/QuickTradeModal.tsx`, `ConfirmCloseModal.tsx` |
| `requireStopLoss` disables Confirm | `components/live/LiveSharedTradeTicket.tsx` |

## 5. Single source of truth

`getEffectiveTradingGovernance(userId, accountMode, role)` —
`artifacts/api-server/src/lib/governance/effectiveGovernance.ts`. Merges
`global_trading_settings`, `user_master_live_access`, `arx_live_user_settings`,
`owner_governance_settings`, and `isOwnerUnrestricted`. Returns each policy with
`{ value, enabled, source, appliesTo, blocksTrading, changeableInGovernance,
brokerEnforced }`. Owner/admin defaults = restrictions OFF; normal users =
protective. Consumed by dispatch AND the frontend payload routes so the UI and
the backend always agree.

## 6. Permanent checks never moved or bypassed (Owner list A)

Auth; owner/admin-or-approved; correct user/account ownership; server-side trade
filtering; master-account privacy; no cross-user exposure; bridge connected;
EA/terminal connected; account type live/real; broker symbol exists/tradable;
broker lot rules; broker price/tick rules; broker accepts order; MT5 returns a
real ticket; ARX ledger records the trade; no success before MT5 confirmation;
no Demo; no Paper; no fake execution; no simulated data.

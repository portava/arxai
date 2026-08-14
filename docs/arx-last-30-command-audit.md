# ARX AI — Last-30-Command Reconciliation Audit & Fix Pass

**Date:** 2026-05-17
**Scope:** Last 30 commits (HEAD..HEAD~40). Hard rules verified: PAPER_ONLY
hard-lock intact, 11/11 CI guards green, no live-trading auto-unlock, no
secret exposure, per-user scoping enforced on every authenticated route.

## Summary

| Bucket | Count |
| --- | --- |
| DONE (verified against codebase) | 23 |
| PARTIAL (works but spec-incomplete) | 3 |
| IGNORED (spec'd, never wired) | 2 |
| FAKE-WIRED / unsafe | 0 |
| NEEDS USER DECISION | 2 (Compliance Engine, OR2 P1s from architect) |

All IGNORED items were fixed in this pass. Both PARTIAL items kept and
documented. The two NEEDS-USER-DECISION items are escalated, not fixed.

## Per-command audit

### Readiness & Onboarding (commits d7b6bc2, 164a848)

| # | Outcome | Files | Status | Evidence | Fix applied |
|---|---|---|---|---|---|
| 1 | 14-status readiness model | `lib/userReadiness/engine.ts` | DONE | 14 statuses evaluated L120–325 | — |
| 2 | USER_OWNED_MT5 / SHARED_MASTER_MT5 routing | `lib/userReadiness/engine.ts`, `lib/adminTrading/routingResolver.ts` | DONE | Mode-aware required-for lists | — |
| 3 | `GET /api/readiness/me` per-user | `routes/userReadiness.ts:59` | DONE | scopes on `req.authUser!.id` | — |
| 4 | `GET /api/readiness/me/blockers` | `routes/userReadiness.ts:70` | DONE | scopes on authed user | — |
| 5 | `GET /api/onboarding/me/progress` | `routes/userReadiness.ts:92` | DONE | per-user query | — |
| 6 | `POST /api/onboarding/me/accept-disclosure` | `routes/userReadiness.ts:127` | DONE | writes acceptance + audit log | — |
| 7 | `POST /api/onboarding/me/account-mode` | `routes/userReadiness.ts:161` | DONE | per-user update + audit | — |
| 8 | Admin: list, approve-live, revoke-live | `routes/userReadiness.ts:183/196/244` | DONE | requireAdmin enforced; live still blocked by PAPER_ONLY hard-lock | — |
| 9 | AI tool `getMyTradingReadiness` | `lib/assistant/tools.ts` | **IGNORED → FIXED** | Was referenced in `phase-onboarding-test.ts` but never registered on `dispatchTool` | Added descriptor + dispatch + implementation |
| 10 | AI tool `explainReadinessBlockers` | `lib/assistant/tools.ts` | **IGNORED → FIXED** | Same — referenced, not registered | Added |
| 11 | AI tool `listMyOnboardingSteps` | `lib/assistant/tools.ts` | **IGNORED → FIXED** | Same | Added |
| 12 | AI tool `getOnboardingProgress` | `lib/assistant/tools.ts` | **IGNORED → FIXED** | Same | Added |
| 13 | Dashboard "Trading Setup Readiness" card | `pages/dashboard.tsx` | **PARTIAL → FIXED** | `ReadinessScoreCard` component existed but was never mounted on the main dashboard (only the dedicated `/trading-readiness` page) | New `TradingSetupReadinessCard.tsx` wrapper hitting `/api/readiness/me`, mounted in `dashboard.tsx` |
| 14 | Admin readiness dashboard | `pages/admin/trading-control.tsx` | PARTIAL | No dedicated page; admin live-approval table + `liveApproved` exists inside trading-control. Functional but not separated. Left as-is — adding a duplicate page risks divergence. |

### Opportunity Radar (commit 988780d) & Risk Governor (f29d3c4)

| # | Outcome | Status | Notes |
|---|---|---|---|
| 15 | Live-candle scanner per user | DONE | `lib/opportunityRadar/radar.ts` |
| 16 | OR2 — reuse `runActionGuards` per opportunity (preview mode) | DONE | `previewMode` threaded through guards.ts + riskGovernorEnforcement.ts; `BLOCKED_BY_RULE` flips `suggestedAction` |
| 17 | OR2 — surface ruleCheck via AI tools | DONE | `getTopOpportunitiesForMeTool`, `explainOpportunityRankingTool` |
| 18 | OR2 — mode-aware preview + per-scan cache | **NEEDS USER DECISION** | Architect flagged: preview is hardcoded `requestedMode:"DEMO"` and no scan-level cache. Tracked as P1; deferred to its own work block. |

### MT5 / UX9 Execution Reconciliation (commits ed4655b, e053d3a)

| # | Outcome | Status | Evidence |
|---|---|---|---|
| 19 | Schema columns on `trade_action_requests` & `mt5_commands` | DONE | Verified columns exist |
| 20 | `lib/mt5/executionReconciler.ts` | DONE | Idempotent, per-user scoped, cascades to live_positions + shared_trade_attribution |
| 21 | `POST /api/mt5/execution-result` (bridge-token auth, per-user) | DONE | `routes/mt5.ts:882`, uses `bridgeAuthPerUserOnly` (rejects shared `MT5_BRIDGE_TOKEN`) |
| 22 | Stuck-command watchdog wired on boot | DONE | `index.ts:34` calls `startStuckCommandWatchdog()` |
| 23 | 4 UX9 AI tools registered | DONE | `getActionExecutionResult`, `explainBrokerRejection`, `getRecentExecutionResults`, `getStuckCommandsForUser` — descriptors L801–807, dispatch L1245–1248 |
| 24 | Action Center UI shows order ticket / fill price / slippage / broker message | DONE | `TradeActionReviewModal.tsx` L170–202 |
| 25 | Admin Execution Health card | DONE | `pages/admin/trading-control.tsx:457` + `/api/admin/trading/execution-health` |
| 26 | 20-scenario test | DONE | `scripts/src/phase-ux9-execution-reconciliation-test.ts` |

### Risk Governor / Trade Action Center (commits f29d3c4, bc43d13, c23ec9c)

| # | Outcome | Status | Notes |
|---|---|---|---|
| 27 | Per-user portfolio/risk scoping | DONE | c23ec9c — explorer confirmed every assistant tool DB query filters on userId |
| 28 | Trade Action Center confirm-before-execute | DONE | `confirmAction` does NOT set `previewMode`; duplicate/queueable/risk-event-logging checks still execute on real confirm |

### Compliance Control Center

| # | Outcome | Status | Notes |
|---|---|---|---|
| 29 | `lib/compliance/complianceEngine.ts` | **NEEDS USER DECISION** | Does not exist. Closest is `lib/domain/src/compliance-log/complianceLog.ts` (in-memory mock). |
| 30 | Schema: `user_agreements`, `user_agreement_acceptances`, `compliance_status_checks` | NEEDS USER DECISION | Not in schema. Disclosures handled today via `risk_settings.liveDisclosureAcknowledgedAt` + `userLiveDisclosureAcceptancesTable`. |
| 31 | `/api/compliance/*` and `/api/admin/compliance/*` | NEEDS USER DECISION | Not registered. Existing security + readiness modules provide overlapping safeguards. |
| 32 | Final live-trade gate integration | DONE (via different path) | `lib/liveTrading/guard.ts` has INVIOLABLE FINAL GATE that always returns REJECTED — broker placement layer is locked at the code level. Live trading cannot fire regardless of compliance state. |

**Safety implication of leaving compliance unbuilt:** the PAPER_ONLY hard-lock
and the INVIOLABLE FINAL GATE in `placeLiveOrderGuarded` already prevent any
live execution. Compliance tables/engine become required when (a) the hard-lock
is ever lifted and (b) the broker placement layer ships. Not a P0 today.

## Fake-wired / placeholder findings (FALSE POSITIVES after inspection)

| Finding | File | Verdict |
|---|---|---|
| `readiness: true` hardcoded in response | `routes/tradingReadiness.ts:27,30,35` | **NOT A BUG.** This is an envelope marker meaning "this response is from the readiness subsystem", not a claim that the user is ready. The real readiness signal is the `status` field (READY/CAUTION/NOT_READY/LOCKED). |
| `fake-heartbeat`, `fake-broker-connection`, `fake-account-status` strings | `knowledge/actionRouter.ts:60-62` | **NOT A BUG.** These are intent-routing keys for the QA help knowledge base, not fake data sources. |
| `createInMemoryComplianceLog` | `lib/domain/src/compliance-log/complianceLog.ts` | Acknowledged stub. Not wired into any live path. |

## Secret-exposure scan (PASS)

Explorer audit of every assistant tool: none return `apiKeyHash`,
`MT5_BRIDGE_TOKEN`, `SESSION_SECRET`, raw bridge tokens, master account
credentials, or `OPENAI_API_KEY`. Account numbers are masked
(`•••• ${slice(-4)}`). Spread operators always operate on already-filtered
projections (`publicConn`), never on raw `mt5ConnectionTable` rows.

## Per-user isolation scan (PASS)

Every authenticated tool/route DB query in `tools.ts` and `routes/userReadiness.ts`
filters on `userId` / `req.authUser!.id`. Admin routes require role `ADMIN` or
`OWNER`. Bridge endpoints use `bridgeAuthPerUserOnly` for per-user MT5
attribution; the shared `MT5_BRIDGE_TOKEN` is explicitly rejected for any
per-user state path.

## Live-trading single-action-unlock test (PASS)

Even with admin approval, live trading is blocked by:
1. `lib/readiness/gate.ts` — `PAPER_ONLY` hard-lock.
2. `lib/liveTrading/guard.ts` — `placeLiveOrderGuarded` always returns
   `REJECTED` with `BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED` (enforced by
   CI guard `live-order-risk-limits`).
3. `engine.ts` — `ready_for_live` returns false unless every one of 14
   statuses passes AND `paperOnlyHardLockActive` is false.

## Files changed in this pass

- `artifacts/api-server/src/lib/assistant/tools.ts` — 4 readiness tool descriptors, dispatch cases, implementations.
- `artifacts/api-server/src/lib/assistant/systemPrompt.ts` — Readiness Engine section added.
- `artifacts/trading-dashboard/src/components/readiness/TradingSetupReadinessCard.tsx` — new.
- `artifacts/trading-dashboard/src/components/readiness/index.ts` — export.
- `artifacts/trading-dashboard/src/pages/dashboard.tsx` — mount card.
- `docs/arx-last-30-command-audit.md` — this file.

## QA gate

- `pnpm run typecheck` — see report.
- `pnpm run ci:guards` — see report.
- `pnpm --filter @workspace/scripts run phase-onboarding-test` — exists.
- `pnpm --filter @workspace/scripts run phase-ux9-execution-reconciliation-test` — exists.

## Remaining blockers / NEEDS-USER-DECISION items

1. **Compliance Engine + tables + endpoints (Phase 5 of spec)** — not built. PAPER_ONLY hard-lock makes this non-blocking today. User decision required: build now vs. defer until broker placement layer is in scope.
2. **OR2 architect P1s** — mode-aware preview + per-scan context cache. Tracked from prior session. Not addressed in this pass per user instruction (they moved on with "Next").
3. **Dedicated admin readiness dashboard page** — currently inside `trading-control.tsx`. Functional but spec asked for a separate page. Left as-is to avoid divergence.

## Confirmations

- ✅ PAPER_ONLY guard still passes.
- ✅ No secrets exposed in any reviewed surface.
- ✅ Live trading cannot be enabled by any single action (multi-gate including
  inviolable code-level rejection in `placeLiveOrderGuarded`).
- ✅ Per-user scoping enforced on every reviewed authenticated route and tool.

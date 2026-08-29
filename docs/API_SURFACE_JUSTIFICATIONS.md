# API surface justifications

Every router mounted in `artifacts/api-server/src/routes/index.ts` must be
reachable by a human — a dashboard call site or an entry in
`lib/api-spec/openapi.yaml` — **or** be listed here with a category and a
reason. `scripts/src/ci/check-router-reachability.ts` enforces this and fails
the build otherwise.

This file exists because a mounted router looks delivered. It typechecks, its
tests pass, and it gets counted as a shipped capability — while no human can
reach it. An audit found ~47 routers in that state, including `/me/authority`,
whose absence turned the mission-promotion blocker message ("obtain an active
owner-pressed authority grant") into a dead end.

**`NOT_DELIVERED` means exactly what it says.** A router listed under that
category is built, mounted, and reachable by nobody. It is **not** a delivered
capability and must never be reported as one. The entry is an admission, not an
exemption.

## Categories

| Category | Meaning |
|---|---|
| `EA_BRIDGE` | Polled by the MT5 EA / bridge process. A browser is not the client. |
| `WEBHOOK` | Called by an external system. |
| `CI_ONLY` | Exercised by CI / QA lanes only. |
| `INTERNAL_TOOLING` | Driven by a CLI or script, not a page. |
| `NOT_DELIVERED` | Built and mounted, reachable by no human. Not shipped product. |

## Format

    - `<routeModule>` — CATEGORY: reason

The module name is the file stem under `artifacts/api-server/src/routes/`.

---

## EA-facing surfaces

- `mt5DemoBridge` — EA_BRIDGE: the demo command-poll and result endpoints the MT5 Expert Advisor calls with a per-user bridge token; there is no browser client by design.
- `mt5Live` — EA_BRIDGE: the Phase B live command-poll and fill-report endpoints the EA calls with a per-user bridge token; a browser must never be able to call these.
- `mt5RemoteOps` — EA_BRIDGE: remote EA config delivery, update check and update report, all authenticated by the per-user bridge token rather than a session.

## CI / QA-driven surfaces

- `dailyTesting` — CI_ONLY: the daily owner-testing store, driven by scripts/src/test-system.ts and qaAuthLoginRoles.ts; it has no product surface and is not offered to users.
- `meAllocation` — CI_ONLY: the lightweight allocation-card payload, currently read only by scripts/src/allocationRuntimeQa.ts and qaPerfBackendSweep.ts; the product reads the fuller /api/me/live/slot-summary instead.

## Removed rather than wired

Not every orphan should be given a surface. Recorded here so the decision is
not silently re-litigated.

**Smart alert rule engine** (`artifacts/api-server/src/lib/alerts/ruleEngine.ts`,
deleted). Eight proactive safety rules — broker disconnected, price feed
delayed, position near stop loss, trade plan invalidated, risk lock active,
weekly review ready, approaching daily loss limit, market NO_TRADE — with zero
callers anywhere in the repository: no route, no worker, no scheduler.

Wiring it as a worker was the obvious move and was rejected. `alerts` is read
and written **without user scope**; the rules read global tables and put
per-user detail in the message (symbols, live position ids, plan ids, today's
realised loss), and those rows are read back by `getCriticalUnread()`, which
reaches any authenticated caller through `POST /api/help/why-blocked`. Firing
the engine would have leaked one user's open positions and P/L into another
user's "Why am I blocked?" drawer — the same global-scope leak Phase 22C closed
when it neutralised `routes/alerts.ts`.

**Correction (review, 2026-08-29).** This entry previously said the `alerts`
table "has no `userId` column". That was false. `lib/db/src/schema/alerts.ts:8`
declares `userId: integer("user_id")` — nullable, added by Build L, commented
"for future multi-user". The defect is an **unused** column, not a missing one:
`CreateAlertInput` (`lib/alerts/alertManager.ts`) has no `userId` field, so every
producer writes NULL, and `getAlerts()` / `getUnreadCount()` /
`getCriticalUnread()` filter on nothing. Describing it as absent hid the cheapest
remedy — populate and filter the column that already exists. That remedy is real
work, not a one-liner: every existing row is NULL, so a naive
`where user_id = :caller` would silently hide alerts that are genuinely firing,
which is worse than the leak it closes. It needs its own change with a backfill
decision.

**Consequence, stated precisely: ARX has no proactive safety *rule engine*.**
The eight rules above are never evaluated, so the conditions they watch —
position near stop loss, trade plan invalidated, approaching the daily loss
limit — raise nothing.

This is **not** the same as "nothing generates alerts", which this entry also
used to claim and which is false. Sixteen live `createAlert()` call sites across
eleven files still write rows to this table, including safety ones:
`lib/fundbook/fundControls.ts` (CRITICAL), `lib/aaci/reconciliationAudit.ts`,
`lib/data/mt5FeedStalenessWatchdog.ts`, `lib/onboarding/state.ts`,
`lib/onboarding/whyBlocked.ts`, and the `tradeManagement`, `mt5` (e.g.
`MT5_DISCONNECTED`), `newsCalendar`, `adminBridgeControl`, `tradePlans` and
`portfolioRisk` routes. An empty alert surface therefore does **not** license the
reading "nothing is wrong" — and, equally, a populated one is not proof the rule
engine's conditions are being watched.

Because those producers are live and unscoped, `GET /trading-cockpit/summary` no
longer returns alert `title`/`message` (see the security note below). Rebuilding
the rule engine belongs on the per-user surface (`routes/meNotifications.ts`),
the canonical successor named by `routes/alerts.ts`.

### Cross-user alert text — closed at the read surface, not at the table

`GET /api/trading-cockpit/summary` called `getCriticalUnread()` (no user scope)
and returned the top five rows' `title` and `message` to the caller. With a live
CRITICAL producer (`lib/fundbook/fundControls.ts:549`), that meant one account's
alert text reached another account. The route now returns only
`{ id, type, priority, createdAt }` plus an explicit
`scope: "SYSTEM_WIDE_UNSCOPED"` and `detailWithheld: true`, and the cockpit page
says so rather than implying the list is the reader's own.

**This is a mitigation, not a fix.** The count and the alert *type* are still
system-wide facts shown to an individual caller. Closing that properly requires
the per-user scoping described above and is not done here.

## NOT DELIVERED — built, mounted, reachable by no human

These are recorded so nobody counts them as shipped. Each is a candidate for a
surface or for unmounting; neither decision has been made yet, and until one is,
the honest statement is that the capability does not exist for any user.

- `adminLiveAccount` — NOT_DELIVERED: master MT5 totals, per-user slot summaries and unassigned-position triage for admins; no admin page calls it.
- `adminOwnerDecisions` — NOT_DELIVERED: the append-only owner-decision registry has no reader in the product; rulings are maintained by hand in docs/OWNER_DECISIONS.md instead.
- `adminRubyExecution` — NOT_DELIVERED: assistant execution-command inspection for admins with no page behind it.
- `adversarialValidation` — NOT_DELIVERED: adversarial edge-fragility analysis; pure engine over request-body inputs, with no caller anywhere in the product.
- `agentEcosystem` — NOT_DELIVERED: 33 handlers of agent-ecosystem reporting; the admin agent-ecosystem page does not call any of them.
- `agents` — NOT_DELIVERED: agent-council evaluation endpoints with no caller in the product.
- `autoDebrief` — NOT_DELIVERED: automated post-trade debrief processing that no page or worker triggers.
- `brokerCatalog` — NOT_DELIVERED: the multi-broker venue catalog, honest about unimplemented venues, but no screen renders it.
- `cognitive` — NOT_DELIVERED: cognitive-assessment endpoints over request-body inputs, with no caller.
- `continuousValidation` — NOT_DELIVERED: continuous confidence-health validation with no consumer.
- `decisionIntelligence` — NOT_DELIVERED: 16 decision-quality handlers over request-body inputs; nothing calls them.
- `economy` — NOT_DELIVERED: internal agent-economy and reputation endpoints with no product consumer.
- `ecosystem` — NOT_DELIVERED: 25 ecosystem-scoring handlers over request-body inputs; nothing calls them.
- `execution` — NOT_DELIVERED: execution-assessment endpoints (assessment only, no dispatch) with no caller.
- `executionIntelligence` — NOT_DELIVERED: pre-trade cost/slippage estimation with no caller in the product.
- `integrationTests` — NOT_DELIVERED: an in-product integration-test runner with no page and no CI lane invoking it.
- `meBetaStatus` — NOT_DELIVERED: per-user beta status read; the beta surfaces use other endpoints.
- `meGuidedPositions` — NOT_DELIVERED: the Phase 6 guided position centre, journal and debrief reads; no page consumes them.
- `mePaperBetaReadiness` — NOT_DELIVERED: the bundled paper-beta readiness gate; no page shows its verdict.
- `mePrivacy` — NOT_DELIVERED: privacy settings and global-learning opt in/out; no settings screen calls it, so a user cannot change these choices in the product.
- `meTradingView` — NOT_DELIVERED: the TradingView webhook plus its token management; with no screen to mint a webhook token, the webhook itself cannot be used by anyone.
- `personalEdge` — NOT_DELIVERED: trader-DNA personal-edge baselines with no consumer.
- `replayLabSim` — NOT_DELIVERED: 11 replay-lab simulation handlers with no caller; the Market Replay page uses a different surface.
- `temporalIntelligence` — NOT_DELIVERED: trader-DNA temporal analysis with no consumer.
- `tradeDecision` — NOT_DELIVERED: trade-decision evaluation over request-body inputs; nothing calls it.
- `traderDNA` — NOT_DELIVERED: trader-DNA profile reads with no consumer.
- `validationCommandCenter` — NOT_DELIVERED: 12 statistical-validation handlers with no page.
- `validationPipeline` — NOT_DELIVERED: 12 validation-pipeline handlers with no page.

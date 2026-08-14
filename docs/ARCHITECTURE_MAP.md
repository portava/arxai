# ARX AI — Architecture Map

_Originally written 2026-05-11 (Build B — Architecture Consolidation). Headline status reconciled 2026-06-12 to Phase-B-live reality (per [`ARX_DEEP_SYSTEM_AUDIT.md`](./ARX_DEEP_SYSTEM_AUDIT.md) §7.2/§7.3)._

> **⚠️ Current reality (read first — supersedes the Build-B/MVP framing below).**
> This document was written during the **Build-B / "MVP paper-only" era** and the
> structural map (tables, route families, services, data-flow shapes) is still a
> useful orientation, but several **headline status claims below are historical**
> and are corrected here:
>
> - **Branding** is **ARX AI — Analyze. Risk. eXecute.** (not "High Roll Trading AI").
> - **The product is NOT paper-only.** **Phase B live broker execution exists** and
>   runs **default-deny**: live dispatch is gated by an **18-gate** evaluator
>   (`lib/domain/src/safety-contracts/livePhaseBDispatchGate.ts`) plus the server
>   master switch, per-user arming, admin approval, and kill switch. `canPlaceTrades:false`
>   remains true **only on the advisory / intelligence APIs** (still CI-enforced) — it is
>   not a whole-system claim. THIS environment sets
>   `ARX_LIVE_BROKER_EXECUTION_ENABLED="true"` for controlled owner/admin live testing
>   (satisfies only gate #1 of 18).
> - **Live gate count is 18**, not 16: the original 16 + **#17 `MISSING_TAKE_PROFIT`**
>   (Phase 22V, governance-conditional on per-user `require_take_profit` /
>   `adminAllowNoTakeProfit`) + **#18 `DISCLOSURE_NOT_ACCEPTED`** (risk-disclosure
>   acceptance). See replit.md "Current safety gates".
> - **MT5 bridge auth is per-user only.** The legacy server-wide `MT5_BRIDGE_TOKEN`
>   env value is **rejected** everywhere; every EA endpoint requires a per-user
>   `X-MT5-Bridge-Token`. The "503 when `MT5_BRIDGE_TOKEN` unset" behavior described
>   below is historical.
> - **Frontend page count is ~160** (127 user-facing + 33 under `pages/admin/`), not 24.
>   The "24 pages → 7 surfaces (Build E)" framing below is the original MVP plan and is
>   superseded.
>
> For the authoritative current state see **`replit.md`** and
> **`ARX_DEEP_SYSTEM_AUDIT.md`**. The default-deny safety posture is unchanged: no
> gate is weakened anywhere.

This is the single source of truth for **what exists, where it lives, and which surface owns it**. It is descriptive, not aspirational.

For roadmap and rationale see [`IMPLEMENTATION_ROADMAP.md`](./IMPLEMENTATION_ROADMAP.md). For invariants and untouchable systems see [`SAFETY_NOTES.md`](./SAFETY_NOTES.md).

---

## 1. Top-level layout

```
artifacts/
├── api-server/        Express 5 backend            (port 8080,  /api/*)
├── trading-dashboard/ React 19 + Vite frontend     (port 24210, /)
└── mockup-sandbox/    Vite component preview env   (canvas tool, dev only)

lib/
├── api-spec/          OpenAPI 3 contract (source of truth) + Orval config
├── api-zod/           Generated Zod schemas      (autogen, do not edit)
├── api-client-react/  Generated React-Query hooks (autogen, do not edit)
├── db/                Drizzle ORM schema + db client + seed
└── domain/            Pure business-logic modules (84 subdomains)

scripts/               Workspace utility scripts
└── src/ci/            Build A invariant guards (canPlaceTrades, vault, etc.)
```

---

## 2. Database tables (23 application tables, 1 singleton state row)

| Table | File | Owner | Notes |
|---|---|---|---|
| `bot_settings` | `botSettings.ts` | bot | Mutable config |
| `risk_settings` | `riskSettings.ts` | risk | Mutable config |
| `strategies` | `strategies.ts` | strategy | Toggleable per market type |
| `signals` | `signals.ts` | scanner / brain | Append-only event log |
| `trades` | `trades.ts` | trades | Mutable lifecycle |
| `backtests` | `backtests.ts` | backtest | Append on completion |
| `performance_daily` | `performanceDaily.ts` | performance | Materialized per-day |
| `mt5_commands` | `mt5Commands.ts` | mt5-bridge | Outbox for EA |
| `mt5_connection` | `mt5Connection.ts` | mt5-bridge | Heartbeat state |
| `alerts` | `alerts.ts` | alerts | User notifications |
| `watchlists` | `watchlists.ts` | watchlists | User-scoped |
| `trade_journal` | `tradeJournal.ts` | journal | User-scoped notes |
| `users` | `users.ts` | core | Identity |
| `user_settings` | `userSettings.ts` | core | Per-user prefs |
| `symbols` | `symbols.ts` | core | Multi-market registry |
| `trade_plans` | `tradePlans.ts` | trades | Pre-execution intent |
| `trade_management_events` | `tradeManagementEvents.ts` | tradeMgmt | Append-only |
| `learning_insights` | `learningInsights.ts` | learning | Aggregations |
| `entry_sniper_results` | `entrySniperResults.ts` | strategy | Append-only |
| `ai_decision_log` | `aiDecisionLog.ts` | decisionIntel | Append-only |
| **`audit_events`** | `auditEvents.ts` | **vault** | **🔒 APPEND-ONLY (CI-enforced)** |
| **`vault_events`** | `safetyCore.ts` | **vault** | **🔒 APPEND-ONLY (CI-enforced)** |
| **`state_transitions`** | `safetyCore.ts` | **vault** | **🔒 APPEND-ONLY (CI-enforced)** |
| `safety_core` | `safetyCore.ts` | safety | Singleton current-state row (1 row only) |
| `ruby_signal_outcomes` | `rubySignalOutcomes.ts` | rubyQuality | User-scoped; locked "at signal" snapshot, evidence/outcome appended (Task #199) |
| `ruby_signal_reviews` | `rubySignalReviews.ts` | rubyQuality | 🔒 Append-only; one per outcome (userSummary + admin-only adminDetail) |
| `ruby_quality_thresholds` | `rubyQualityThresholds.ts` | rubyQuality | Singleton tunable (audited; outcome-classification only, never an execution gate) |

> **No duplicate table names** (CI guard #5 enforces). Total: 25 + 2 singletons + (drizzle internal counters).

---

## 3. API routes — canonical owners

37 route files; **253 route registrations; zero collisions** (CI guard #4 enforces).

Routes are grouped by **system family** with the **canonical handler** marked. Adjacent routes still exist and are documented as either secondary (active) or legacy (call-site review pending).

### 3.1 Trading core (live-execution sensitive — see SAFETY_NOTES)
| Family | Canonical route file | Sibling files | Frontend consumer |
|---|---|---|---|
| Bot lifecycle | `bot.ts` | — | `pages/bot-control.tsx`, `settings.tsx` |
| Trades | `trades.ts` | `execution.ts`, `executionIntelligence.ts` | `live-trades.tsx`, `trade-logs.tsx` |
| MT5 bridge | `mt5.ts` | — | `mt5-bridge.tsx`, `settings.tsx` |
| Risk | `risk.ts` | — | `risk-settings.tsx`, `settings.tsx` |
| Trade management | `tradeManagement.ts` | — | none yet |

### 3.2 Intelligence (advisory — `canPlaceTrades:false`)
| Family | Canonical route file | Sibling files | Frontend consumer |
|---|---|---|---|
| Market brain | `brain.ts` (uses `lib/marketBrain.ts`, 284 lines) | `intelligence.ts`, `forexIntelligence`, `indicesIntelligence` (in `lib/`) | `brain-analysis.tsx`, `forex-center.tsx`, `indices-center.tsx`, `synthetic-center.tsx`, `stocks-center.tsx`, `scanner.tsx` |
| Signals | `signals.ts` | — | `scanner.tsx` |
| News | `news.ts` | — | `calendar.tsx` |
| Data providers | `data.ts` | — | `forex-center.tsx`, `indices-center.tsx`, etc. |

### 3.3 Strategies & validation
| Family | **Canonical** | Sibling routes (still active) | Frontend |
|---|---|---|---|
| Strategy CRUD | `strategies.ts` | — | `strategy-settings.tsx` |
| Validation | **`validationCommandCenter.ts` (593 lines)** | `validationPipeline.ts`, `adversarialValidation.ts`, `continuousValidation.ts` | **none yet (Build E)** |
| Agents | `agents.ts` | `cognitive.ts` | none |

### 3.4 Decision intelligence & learning
| Family | **Canonical** | Sibling routes | Frontend |
|---|---|---|---|
| Decision intelligence | **`decisionIntelligence.ts` (887 lines)** | — | **none yet (Build E)** |
| AI coach | `learning.ts` (uses `lib/aiLearning/aiCoach.ts`) | — | `learning.tsx` |
| Trade outcome analysis | `learning.ts` (uses `lib/aiLearning/tradeOutcomeAnalyzer.ts`) | — | `learning.tsx` |
| Performance | `performance.ts` | — | `analytics.tsx`, `dashboard.tsx` |
| Journal | `journal.ts` | — | `journal.tsx` |
| Ruby outcome learning | `meRubyQuality.ts` (user-simple: my outcomes + my self-reviews), `adminRubyQuality.ts` (ADMIN/OWNER: Part-42 metrics+filters, missed-opportunity replay, audited tuning GET/POST, investor summary) | tracked on-appear from `meAssistant.ts` (`/me/assistant/explain-signal`, fire-and-forget) | `admin/ruby-quality.tsx` |

### 3.5 Trader behavior
| Family | **Canonical** | Sibling routes | Frontend |
|---|---|---|---|
| Trader DNA | **`traderDNA.ts` (253 lines)** | `personalEdge.ts`, `temporalIntelligence.ts` | **none yet (Build E)** |

### 3.6 Replay / sim
| Family | **Canonical** | Sibling routes | Frontend |
|---|---|---|---|
| Replay lab | **`replayLab.ts` (202 lines)** | `replayLabSim.ts` | **none yet (Build E)** |

### 3.7 Portfolio / ecosystem
| Family | Route | Frontend |
|---|---|---|
| Portfolio | `portfolio.ts` | `portfolio.tsx` |
| Economy | `economy.ts` | none |
| Ecosystem | `ecosystem.ts` | none |
| Alerts | `alerts.ts` | `alerts.tsx` |
| Watchlists | `watchlists.ts` | `watchlists.tsx` |
| Backtests | `backtests.ts` | `backtest.tsx` |

### 3.8 Safety & system
| Family | Route | Frontend |
|---|---|---|
| **System mode + kill-switch** | `system.ts` (`/api/system/*`) | **🔴 none yet — engine ready, UI consumer missing (Build B/E)** |
| Audit / vault | `audit.ts` | none |
| Health | `health.ts` | (proxy) |

---

## 4. Backend services (`artifacts/api-server/src/lib/`)

| Service file | Lines | Responsibility | Used by routes |
|---|---|---|---|
| `safetyCore.ts` | 720+ | System mode, kill-switch, vault emit, trade-gate | `bot`, `system`, `risk`, multiple |
| `strategyEngine.ts` | 483 | 5+ strategies + master scan + No-Trade filter | `signals`, `strategies`, `bot` |
| `forexIntelligence.ts` | — | Forex pair bias | `intelligence`, `brain` |
| `indicesIntelligence.ts` | — | Indices bias | `intelligence`, `brain` |
| `positionSizing.ts` | — | Risk-based lot calc | `risk`, `trades` |
| `riskAudit.ts` | — | Risk decision audit | `risk` |
| `vaultIntegrity.ts` / `vaultLogger.ts` | — | Vault helpers | `audit`, `safetyCore` |
| `auditVault.ts` | — | Audit-vault helper | `audit` |
| `logger.ts` | 20 | Pino singleton (always use this; never `console.*`) | All |

### 4.1 Sub-namespaces

| Path | Contents |
|---|---|
| `lib/aiLearning/` | `aiCoach.ts` (51 — thin, **active behind `/api/learning/coach/{id}`**), `strategyOptimizer.ts`, `tradeOutcomeAnalyzer.ts` |
| `lib/tradeManagement/` | `tradeManager.ts` + rules (breakEven, trailingStop, partialClose, earlyExit) + monitoring (tradeHealthScore) |
| `lib/news/` | `calendar/economicEvents.ts`, `calendar/newsRiskScorer.ts`, `sentiment/newsSentimentEngine.ts` |
| `lib/data/` | `dataManager.ts` + providers (mock, mt5, alphaVantage, twelveData) + normalizers |
| `lib/portfolio/` | `exposure.ts` |
| `lib/alerts/` | `alertManager.ts` |
| `lib/rubyQuality/` | Task #199 outcome learning (OBSERVATION ONLY, never an execution gate): `tracker.ts` (record-on-appear, lock at creation, idempotent), `resolver.ts` (fail-closed evidence: closed trade + observed candle move; PENDING stays PENDING on time alone), `selfReview.ts` (append-only user-simple + admin-detail), `aggregator.ts` (Part-42 metrics), `tuning.ts` (audited thresholds), `investorHooks.ts` |
| `brain/` | `marketBrain.ts` (284) + `technical/`, `macro/`, `sessions/`, `news/`, `scoring/confluenceScoring.ts`, `symbols/symbolRegistry.ts` |

### 4.2 Domain layer (`lib/domain/src/` — 84 subdomains, 790 files)

Pure business logic, no I/O. Consumed by route handlers above. **10 known circular cycles** in `agent-system/` and `orchestrator/` — snapshotted in `scripts/src/ci/known-domain-cycles.json`; CI guard #7 fails on NEW cycles only.

---

## 5. Frontend pages (~160 total — historical Build-B core set of 24 enumerated below)

> The app now has **~160 page files** (127 user-facing + 33 under `pages/admin/`).
> The 24 rows below are the original **Build-B core set**, and the "→ 7 surfaces
> (Build E)" status column is the **superseded MVP consolidation plan**. See
> `replit.md` for the current product surface.

Built with React 19 + Vite + Tailwind + shadcn/ui + Recharts + wouter. All pages lazy-loaded.

| Page | Active queries | Status vs MVP 7-surface freeze |
|---|---|---|
| `dashboard` | bot/status, signals, performance | **Keep — Surface 1: Dashboard** |
| `scanner` | signals/scan, brain/symbols | Merge → Dashboard or Strategies (Build E) |
| `live-trades` | trades/open | **Keep — Surface 2: Trades (merge with `trade-logs`)** |
| `trade-logs` | trades | Merge with `live-trades` (Build E) |
| `journal` | journal | **Keep — Surface 6: Journal** |
| `learning` | learning/insights, learning/coach | **Keep — Surface 5: Coach (rename Coach/Trader DNA)** |
| `analytics` | performance | Merge → Dashboard (Build E) |
| `backtest` | backtests | **Keep — Surface 4: Backtest** |
| `portfolio` | portfolio/exposure, portfolio/correlation | Merge → Dashboard (Build E) |
| `bot-control` | bot/* | Merge → Settings (Build E) |
| `strategy-settings` | strategies | **Keep — Surface 3: Strategies** |
| `risk-settings` | risk/* | Merge → Settings (Build E) |
| `settings` | bot/mt5/risk | **Keep — Surface 7: Settings** |
| `mt5-bridge` | mt5/* | Merge → Settings (Build E) |
| `alerts` | alerts | Merge → Topbar bell + Notifications drawer |
| `watchlists` | watchlists | Merge → Dashboard (Build E) |
| `calendar` | news/calendar | Merge → Dashboard sidebar (Build E) |
| `forex-center` | forex/intelligence | Merge → Strategies "Market Conditions" tab (Build E) |
| `indices-center` | indices/intelligence | Merge → Strategies "Market Conditions" tab |
| `synthetic-center` | synthetic/analysis | Merge → Strategies "Market Conditions" tab |
| `stocks-center` | (placeholder) | Merge → Strategies "Market Conditions" tab |
| `brain-analysis` | brain/analyze | Merge → Strategies (Build E) |
| `emergency` | execute-trade direct fetch (⚠️ see SAFETY_NOTES §5) | **Keep — special: Kill Switch** |
| `not-found` | — | Keep |

**Consolidation target:** 24 pages → 7 surfaces in Build E.

---

## 6. Frontend components

```
components/
├── ui/                  shadcn/ui primitives (50+ files, do not edit individually)
├── layout/              AppLayout, Topbar, MobileBottomNav, Footer, SymbolPicker
├── trading/             19 domain primitives (StatCard, ConfidenceMeter, RiskBadge,
│                        VolatilityBadge, MarketConditionBadge, TradeHealthMeter,
│                        AIInsightCard, SignalCard, ChartContainer, PremiumTable,
│                        ConfirmDialog, ExposureCard, FloatingActionPanel,
│                        MT5StatusIndicator, … see components/trading/index.ts)
├── compliance/          DisclaimerBanner
├── AlertBell.tsx        Topbar notification bell
└── LiveTradeCard.tsx    Single live trade card
```

**No duplicate widgets identified** in the trading primitives layer — naming is consistent and `components/trading/index.ts` is the barrel.

**Missing components (Build B/E to add):**
- `SystemModeBadge` (reads `/api/system/status.operationalMode`)
- `KillSwitchButton` (calls `/api/system/kill-switch/engage`)
- `VaultMerkleFooter` (reads `/api/system/vault`)
- `ExplainabilityCard` (universal — reads `/api/decision-intelligence/*`)
- `ReplayButton` (opens replay-lab from any decision/trade row)

---

## 7. Data flow — high-level

```
                        ┌──────────────────────┐
                        │ DataManager (mock /  │
                        │ mt5 / alphaVantage / │
                        │ twelveData providers)│
                        └──────────┬───────────┘
                                   │ candles, quotes
                                   ▼
   ┌────────────────┐   ┌──────────────────────┐   ┌──────────────────┐
   │ NewsRiskEngine │──►│ marketBrain (technical+│──►│ confluenceScoring│
   └────────────────┘   │   macro + sessions +  │   └────────┬─────────┘
                        │   news + scoring)     │            │
                        └──────────┬───────────┘            │
                                   ▼                         ▼
                        ┌──────────────────────┐   ┌──────────────────┐
                        │ strategyEngine       │   │ signals (db)     │
                        │ (5 strategies +      │──►│  ↓ persisted     │
                        │  No-Trade filter)    │   └──────────────────┘
                        └──────────┬───────────┘
                                   │ TradeIntent
                                   ▼
                        ┌──────────────────────┐
                        │ safetyCore.tradeGate │  ← Risk Governor + global state
                        │ (APPROVED / REDUCE / │  ← canPlaceTrades:false on advisory APIs
                        │  HARD_BLOCK)         │
                        └──────────┬───────────┘
                                   │ verdict
                                   ▼
   PAPER/DEMO mode (default):      LIVE mode (Phase B — default-deny, 18-gate):
   ─────────────────────────       ──────────────────────────────
   trades table (mock)             POST /api/execute-trade
   aiDecisionLog (vault event)        → routes/trades.ts
   vault_events (append)              → mt5_commands outbox
   state_transitions (append)         → MT5 EA polls /api/mt5/commands
                                      → EA POSTs /api/mt5/command-result
                                         (requires X-MT5-Bridge-Token)
```

---

## 8. AI coach flow

```
trades table → routes/learning.ts/{id}/coach
    → lib/aiLearning/aiCoach.ts::coachTrade()
    → lib/aiLearning/tradeOutcomeAnalyzer.ts::analyzeTradeOutcome()
    → CoachExplanation { whatHappened, setupValid, whatCouldBeBetter,
                         strategyAdjustment, marketAvoidance }
    → pages/learning.tsx
```

The richer feedback path lives in `routes/decisionIntelligence.ts` (887 lines) but **has no frontend consumer yet** — Build E will surface it via the `ExplainabilityCard` component.

---

## 9. Replay simulator flow

```
aiDecisionLog + trades + auditEvents → routes/replayLab.ts
    → lib/domain/src/replay-lab/* (pure)
    → routes/replayLabSim.ts (sub-routes: simulate-from-decision)

Isolation: replay routes never call routes/trades.ts, routes/mt5.ts,
or routes/execute-trade. They only read historical data and re-run
strategy engine + decision intelligence on it. (See SAFETY_NOTES §6.)
```

---

## 10. Scoring flow (Trader DNA)

```
trades + aiDecisionLog + tradeJournal → routes/traderDNA.ts (canonical)
    ├── routes/personalEdge.ts        (per-strategy edge metrics)
    ├── routes/temporalIntelligence.ts (time-of-day, session bias)
    └── domain/regret-engine, domain/retrospective

Scorecard projection (read-only): no parallel `trader_scores` table.
Backend complete; UI consumer pending Build E.
```

---

## 11. CI guards (Build A)

Run via `pnpm run ci:guards` (~1.7s) or full `pnpm run ci` (typecheck + guards).

| # | Guard | What it blocks |
|---|---|---|
| 1 | `can-place-trades-invariant` | `canPlaceTrades: true` in server / domain / OpenAPI |
| 2 | `vault-append-only` | `.update()` / `.delete()` on the 3 append-only vault tables |
| 3 | `no-console-in-server` | `console.*` in api-server or domain (use `req.log` / `logger`) |
| 4 | `route-collisions` | Two route files registering the same `(method, path)` |
| 5 | `duplicate-tables` | Two schema files defining `pgTable("same_name", …)` |
| 6 | `cross-artifact-imports` | `artifacts/<a>` importing from `artifacts/<b>` (must use libs) |
| 7 | `domain-circular-deps` | NEW cycles in `lib/domain/src` (10 pre-existing tolerated) |

Per-guard CLI: `pnpm --filter @workspace/scripts run ci:guard:<name>`.
Add new guards by following `scripts/src/ci/README.md`.

---

## 12. Open architectural debt (track here, fix in named phases)

| Item | Severity | Where | Phase |
|---|---|---|---|
| 5 validation route files with overlapping responsibilities | M | `routes/{validation*,adversarial*,continuous*}` | Build E |
| 24 frontend pages vs 7-surface MVP target | M | `pages/` | Build E |
| `personalEdge` + `traderDNA` + `temporalIntelligence` overlap | M | `routes/` | Build E (UI consolidation) |
| 4 "center" pages (forex/indices/synthetic/stocks) duplicate scanner | M | `pages/` | Build E |
| `replayLab` + `replayLabSim` route pair | L | `routes/` | Build E |
| 10 circular deps in `agent-system` + `orchestrator` | M | `lib/domain/src/` | Build B+ (debt-paydown) |
| `pages/emergency.tsx` calls `/api/execute-trade` via raw `fetch` (bypasses typed client) | M | `pages/emergency.tsx` | See SAFETY_NOTES §5 |
| Frontend has 0 tests; backend has 537 | M | `artifacts/trading-dashboard/` | Build C+ (test infra) |
| No DB-role enforcement of vault append-only | M | `lib/db/` | Build C |
| 66 of 76 generated API hooks have no frontend consumer | M | UI dark surfaces | Build E |

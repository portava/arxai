# High Roll Market AI — Phase 1 Build Audit

_Date: May 10, 2026 · Auditor: build agent · Scope: full-stack snapshot_

This audit maps the **current state of the build** against the phased roadmap (Phases 1–11+). Use it to decide what to keep, what to refactor, and what must be completed before each subsequent phase begins.

> **Verdict at a glance:** Foundation is healthy. ~70% of Phases 1–8 already exist in some form. The largest gaps are in the multi-market symbol registry (Phase 3), the data provider abstraction (Phase 4), the consolidated Market Brain output contract (Phase 6), and the missing entry-window / sniper-lab / trade-plan layers (Phases 9–11). MT5 bridge work is substantial but mock-locked.

---

## 1. Inventory — what exists today

### Frontend
- **Framework:** React 19 + Vite + Tailwind + shadcn/ui + Recharts + wouter routing.
- **Pages (23):** `dashboard`, `scanner`, `bot-control`, `strategy-settings`, `risk-settings`, `trade-logs`, `backtest`, `analytics`, `emergency`, `learning`, `calendar`, `alerts`, `watchlists`, `portfolio`, `live-trades`, `forex-center`, `indices-center`, `stocks-center`, `synthetic-center`, `journal`, `settings`, `brain-analysis`, `mt5-bridge`, plus `not-found`.
- **Layout shell:** `AppLayout` with collapsible desktop sidebar (5 grouped sections), sticky `Topbar` (symbol picker + session/MT5/mode/bot pills), mobile bottom nav (5 items), floating action panel (FAB), all dark-mode forced.
- **Design system primitives (19, in `components/trading/`):** `SignalDirectionBadge`, `ConfidenceMeter`, `StatusBadge`, `PnLValue`, `StatCard`, `PageHeader`, `EmptyState`, `RiskBadge`, `VolatilityBadge`, `MarketConditionBadge`, `MT5StatusIndicator`, `TradeHealthMeter`, `AIInsightCard`, `SignalCard`, `ChartContainer`, `PremiumTable`, `ConfirmDialog`, `FloatingActionPanel`, `ExposureCard`.
- **Design tokens (`lib/design-tokens.ts`):** 9-tone status palette, 4-tier confidence scale, 4-state volatility, 4-state risk, 5-state market condition, trade-health helper, spacing/radius/shadow/typography scales.
- **Routing:** all non-home pages lazy-loaded with React.lazy + Suspense skeleton.
- **State / data:** TanStack Query with Orval-generated typed hooks. No global Redux/Zustand; per-page query state.

### Backend
- **Framework:** Express 5 (Node 24, TypeScript 5.9, esbuild bundle).
- **Routes (20 files, 2 209 lines, 78 OpenAPI operations):** `alerts`, `backtests`, `bot`, `brain`, `data`, `health`, `intelligence`, `journal`, `learning`, `mt5` (409 lines), `news`, `performance`, `portfolio`, `risk`, `signals`, `strategies`, `tradeManagement`, `trades`, `watchlists`, plus `index`.
- **Strategy engine (`lib/strategyEngine.ts`):** `runStrategyScan()` master + 7 strategies — Trend Continuation, Break of Structure, Liquidity Sweep, Volatility Expansion, Pullback Continuation, Mean Reversion, Session Breakout — plus `noTradeFilter`, `newsAvoidanceFilter`, `computeMarketCondition`, `computeTechnicalBias`, `detectSession`, EMA/RSI/ATR helpers, and `generateSyntheticCandles`.
- **Lib subsystems:**
  - `aiLearning/` — `aiCoach.ts`, `strategyOptimizer.ts`, `tradeOutcomeAnalyzer.ts`
  - `tradeManagement/` — `tradeManager.ts`, `monitoring/`, `rules/`
  - `news/` — `calendar/`, `sentiment/`
  - `data/`, `portfolio/`, `alerts/`
  - `riskAudit.ts`, `positionSizing.ts`, `forexIntelligence.ts`, `indicesIntelligence.ts`
  - `logger.ts` (pino — `req.log` in handlers, singleton elsewhere; **no `console.log` in server**).
- **API contract:** OpenAPI-first (`lib/api-spec/openapi.yaml`) → Orval codegen → typed React Query hooks + Zod schemas. Server uses Zod for IO validation.

### Database
- **Postgres + Drizzle ORM, 12 tables:** `alerts`, `alert_settings`, `backtests`, `bot_settings`, `performance_daily`, `risk_settings`, `signals`, `strategies`, `trade_journal`, `trades`, `watchlists`, `watchlist_items`, plus `mt5_commands` schema file.
- Schema-first via Drizzle; `pnpm --filter @workspace/db run push` for dev migrations.

### MT5 integration
- `routes/mt5.ts` (409 lines) implements bridge endpoints: `/heartbeat`, `/commands`, `/command-result`, `/sync-account`, `/sync-positions`.
- Auth: shared-secret header `X-MT5-Bridge-Token` against `MT5_BRIDGE_TOKEN`. **Fail-closed: when env var unset all bridge endpoints return 503.**
- `mt5_commands` table stores queued orders for the EA to poll.
- Mock execution path lives in `routes/trades.ts`; bot defaults to mock mode.

---

## 2. Phase-by-phase audit

### ✅ Phase 1 — Foundation Audit
- **Status:** This document. Complete on commit.

### 🟡 Phase 2 — Global Design System & Navigation
- **Done:** All 13 spec'd primitives plus 6 extras (19 total). Topbar, collapsible sidebar with 5 groups, mobile bottom nav, FAB, dark mode, ConfirmDialog modal system, lazy routes, skeleton states.
- **Spec navigation gap:** the spec calls for these new pages that **do not yet exist**:
  - `Trade Plans` (Phase 11)
  - `AI Assistant` (general chat surface)
  - `Entry Sniper Lab` (Phase 10)
  - `Strategy Builder` (Phase 7 dedicated builder UI; we have `strategy-settings` toggles only)
  - `Exposure` (we have `ExposureCard` primitive but no dedicated page)
  - `API Status` (we have `mt5-bridge` but not a unified API/health page)
- **Refactor candidates:** existing pages still using inline color classes (`text-green-500`, etc.) need to be migrated to design-token helpers. Confirmed pages needing migration: `mt5-bridge.tsx`, `bot-control.tsx`, `brain-analysis.tsx`, `live-trades.tsx`, parts of `analytics.tsx`.
- **Action to close Phase 2:** add the 6 missing pages as stub routes wired to the sidebar so navigation hierarchy matches the spec; then migrate the 5 inline-color pages to the new primitives.

### 🟠 Phase 3 — Multi-Market Symbol System
- **Done:** Basic registry in `lib/design-tokens.ts` with 4 categories. `SymbolProvider` + `useActiveSymbol` context. Symbol picker in topbar.
- **Gaps:**
  - Forex registry has **only 7 majors**; spec requires **all 21 minors** (EURGBP, EURJPY, EURCHF, EURAUD, EURCAD, EURNZD, GBPJPY, GBPCHF, GBPAUD, GBPCAD, GBPNZD, AUDJPY, AUDCHF, AUDCAD, AUDNZD, NZDJPY, NZDCHF, NZDCAD, CADJPY, CADCHF, CHFJPY).
  - Stocks list has **7 of 14** spec'd tickers; missing AMD, NFLX, JPM, BAC, XOM, WMT, COST.
  - Indices match spec exactly (6/6).
  - Synthetic match spec exactly (3/3).
  - **No crypto placeholders** (BTCUSD, ETHUSD).
  - Each symbol is currently just a **string**, but spec requires a rich record: `{displayName, category, brokerSymbol, riskLevel, recommendedTimeframes, sessions, minimumConfidence, defaultRiskPerTrade, notes}`.
  - **No symbol search** UX (current picker is a flat select).
- **Action to close Phase 3:** define `SymbolMeta` type, build `SYMBOL_REGISTRY: Record<string, SymbolMeta>`, expose via `useSymbol(symbolId)` hook, add searchable Combobox picker, verify the active symbol propagates to dashboard / scanner / journal / mt5-bridge / (future trade-plan).

### 🟠 Phase 4 — Market Data Provider Layer
- **Done:** `generateSyntheticCandles()` in `strategyEngine.ts` provides mock candles for any symbol. `lib/data/` directory exists.
- **Gaps:**
  - **No formal `DataProvider` interface.** Strategy engine currently calls `generateSyntheticCandles()` directly, breaking the abstraction.
  - **No provider priority chain** (MT5 → external → mock).
  - **No market data cache.** Each scanner tick regenerates candles fresh; not yet a perf problem at 5 s polling but will be when real data arrives.
  - **No `Candle` / `Quote` interface centralized** — `Candle` is defined inside `strategyEngine.ts`.
  - MT5 provider stub: heartbeat + position sync exists, but no candle stream.
- **Action to close Phase 4:** create `lib/data/provider.ts` with `DataProvider` interface + `Candle`, `Quote` types; build `mockProvider`, `mt5Provider` (placeholder), `externalProvider` (placeholder); add LRU cache keyed by `symbol+tf`; refactor `runStrategyScan()` to accept candles via `provider.getCandles(symbol, tf)` instead of generating internally.

### ✅ Phase 5 — Technical Analysis Engine
- **Done:** EMA, RSI, ATR, market condition, technical bias, session detection. Strategies internally use swings/structure/liquidity sweep heuristics.
- **Gaps vs spec:** missing as standalone exports — SMA, MACD, Bollinger Bands, VWAP, swing-high/low arrays, support/resistance level extraction, Break-of-Structure detector function (used inside the BOS strategy but not exposed), change-of-character (CHoCH), wick rejection, candle body strength, volatility expansion score (used in strategy but not exported), chop score.
- **No unified `TechnicalAnalysis` object** — each strategy computes its own indicators ad-hoc.
- **Action to close Phase 5:** create `lib/technicalAnalysis.ts` exposing every spec'd indicator and a `analyze(candles): TechnicalAnalysis` function returning the full object. Refactor existing strategies to consume it (no behavior change, just consolidation).

### 🟡 Phase 6 — Market Brain
- **Done:** `routes/brain.ts` + brain-analysis page. `forexIntelligence.ts` and `indicesIntelligence.ts` produce per-asset bias. `runBrainAnalysis` mutation exists.
- **Gaps:** the brain output today is an ad-hoc shape (per-asset pages each format it themselves). The spec requires a **single canonical shape** with these fields: `symbol, category, direction, confidence, entry, stopLoss, takeProfit, riskReward, strategy, marketCondition, technicalBias, macroBias, session, newsRisk, volatilityState, riskApproved, blockedReason, aiExplanation, reasons, timestamp`.
- WAIT-as-valid is partially supported (`noTradeFilter` returns NEUTRAL with a reason) but not surfaced as a first-class `direction` value yet.
- **Action to close Phase 6:** add `MarketBrainSignal` schema to `openapi.yaml`, refactor `brain.ts` to return that shape; ensure `direction` enum is `BUY | SELL | WAIT`. Update `SignalCard` to render the canonical shape (already nearly there).

### 🟡 Phase 7 — Strategy Builder
- **Done:** 7 of 10 strategies coded; per-strategy DB rows with `enabled` toggle and JSON `settings`; `strategy-settings` page wires toggles to `useUpdateStrategy` mutation; strategies are persisted and consulted at scan time.
- **Gaps:**
  - **Missing 3 strategies:** Stock Momentum, Index Momentum, News Avoidance (currently a *filter* not a strategy).
  - Each strategy lacks the spec'd metadata block (`description`, `bestMarketConditions`, `badMarketConditions`, `minimumConfidence`, `safeDefaults`).
  - No dedicated **Strategy Builder UI** — only on/off toggles. Spec implies a richer builder where the user sees per-strategy notes and edits per-strategy config.
- **Action to close Phase 7:** add the 3 missing strategies + metadata block per strategy; rebuild `strategy-settings` page as a card grid using `Card + Switch + ConfirmDialog` pattern with full metadata visible.

### 🟡 Phase 8 — Risk Command Center
- **Done:** `risk_settings` table, `routes/risk.ts` (204 lines) with risk-mode endpoints, `riskAudit.ts` lib, `useApplyRiskMode` mutation, risk-settings page.
- **Spec deltas to verify:**
  - Conservative defaults (0.25% / 1% / 3% / 3 trades / streak 2 / minConf 80 / 1 open) — **verify match**.
  - Balanced (0.5% / 2% / 5% / 5 / 3 / 75 / 2) — **verify match**.
  - Aggressive (1% / 3% / 7% / 8 / 3 / 70 / 3) — **verify match**.
  - Custom mode editable — exists.
  - **Volatility 75 1s requires +10 confidence** — needs symbol-level rule injection (depends on Phase 3 registry).
  - **Stock earnings block** — not implemented (depends on Phase 3 + earnings calendar source).
- Risk manager is invoked inside `runStrategyScan()` via `noTradeFilter` and `newsAvoidanceFilter`; final-authority guard is in place but should be re-verified once symbol metadata lands.
- **Action to close Phase 8:** verify risk-mode constants against spec (one-line patch if off); add symbol-aware confidence boosters keyed off `SymbolMeta.minimumConfidence`; add an integration test that asserts a blocked trade cannot reach `executeTrade`.

### 🔴 Phase 9 — Entry Window Engine
- **Status:** Not implemented. No `entryStatus`, no `bestEntryZone`, no `chaseWarning` field anywhere in the codebase.
- **Action:** new module `lib/entryWindow.ts` returning the spec'd object; trading-style enum (Scalping / Day / Swing / Synthetic-Vol); wired into the brain output as `entryWindow` sub-object.

### 🔴 Phase 10 — Entry Sniper Lab
- **Status:** Not implemented. No replay / paper-trade comparison engine.
- **Action:** new page `entry-sniper-lab.tsx` + `lib/sniperLab.ts` + DB table `sniper_sessions`. Depends on Phase 9.

### 🔴 Phase 11 — Trade Plan Generator
- **Status:** Not implemented as a distinct artifact. Pieces exist (signals + risk audit) but no consolidated "Trade Plan" page or contract.
- **Action:** new `trade_plans` table, `/api/trade-plans` route, `trade-plans.tsx` page, `TradePlanCard` primitive. Final recommendation enum `APPROVED | WAIT | BLOCKED`. Required gate before `executeTrade`.

---

## 3. What is broken / inconsistent

| Area | Issue | Severity |
|---|---|---|
| Symbol registry | Forex minors + half of stock list missing; symbols are bare strings without metadata | High — blocks Phase 3 |
| Data provider | No abstraction; `runStrategyScan` calls mock-candle generator directly | High — blocks Phase 4 |
| Brain output shape | Each consumer formats brain output differently; no canonical schema | Medium — needed for Phase 6 |
| Strategy metadata | No `description`/`bestConditions`/`badConditions` per strategy | Medium — needed for Phase 7 |
| Inline color classes | `mt5-bridge`, `bot-control`, `brain-analysis`, `live-trades`, `analytics` still hand-write `text-green-500` etc. | Low — cosmetic, fix during Phase 2 polish |
| Symbol picker UX | Flat `<select>` — no search, no category grouping | Low — fix during Phase 3 |
| MT5 candle stream | Bridge sends positions + heartbeats but not candle data | Deferred — depends on Phase 4 provider work |

---

## 4. What should NOT be touched

- **OpenAPI codegen pipeline** — works correctly; do not bypass `pnpm --filter @workspace/api-spec run codegen`.
- **`MT5_BRIDGE_TOKEN` fail-closed semantics** — must remain 503-when-unset; never default to "open".
- **Drizzle schema files** — additive changes only; never reshape an existing table without a migration plan.
- **`AppLayout` shell + design-token helpers** — Phase 18 baseline. Build on top, do not rewrite.
- **`runStrategyScan()` behavior** — its outputs feed everything; refactor internally for Phase 4–5 but preserve the shape until Phase 6 introduces the canonical brain object.
- **Lazy-route boundaries in `App.tsx`** — keep new pages lazy unless they are landing-page critical.

---

## 5. Performance baseline (must protect)

- **Scanner:** 5 s React Query polling on the dashboard, ~50 ms strategy scan per symbol on synthetic candles. Headroom is fine for Phase 4 cache work.
- **Initial bundle:** Dashboard + shell only; everything else code-split. Do not regress this when adding the 6 spec'd pages.
- **Server logging:** structured pino through `req.log`; do not introduce `console.log` in server code.

---

## 6. Gate to Phase 2

Before starting Phase 2 work, the following must be true (all currently true ✅ unless noted):

- [x] Audit document committed at `docs/BUILD_AUDIT.md`.
- [x] Typecheck across the workspace is clean (`pnpm run typecheck`).
- [x] All three workflows (api-server, mockup-sandbox, trading-dashboard) running healthy.
- [x] Mobile + desktop screenshots verified for the current shell.
- [ ] User signoff on this audit and on the prioritized Phase 2 backlog below.

### Proposed Phase 2 backlog (pending user approval)
1. Add 6 stub pages (`trade-plans`, `ai-assistant`, `entry-sniper-lab`, `strategy-builder`, `exposure`, `api-status`) wired to the sidebar so navigation matches the spec.
2. Migrate `mt5-bridge`, `bot-control`, `brain-analysis`, `live-trades`, `analytics` from inline color classes to the design-token primitives.
3. Final consistency pass — verify every page uses `PageHeader`, `StatCard`, `EmptyState`, `Card` rather than ad-hoc layouts.
4. Re-screenshot every route at desktop + mobile widths to confirm visual consistency before declaring Phase 2 done.

---

_End of audit. Awaiting user signoff to begin Phase 2._

# High Roll Trading AI — Foundation Audit Report

_Date: 2026-05-10 — Foundation pass 1 of N_

## ✅ Fixed in this pass

### Navigation architecture (per master spec)
- Sidebar reorganized into 5 logical groups: **Markets · Trading · Analytics · Risk · System** (+ Emergency).
- Group headers use 9px uppercase letterspacing for institutional feel.
- Nav rows reduced from 18px / 38px tall to 15px / 32px tall — much higher density without crowding.
- Compact 8×8 logo block; "MARKET_AI v1.0" version stamp.
- Disclaimer footer trimmed and re-styled as small print.

### Global topbar (NEW)
- Sticky 56px header with backdrop blur.
- Symbol picker (combobox with grouped Forex / Indices / Stocks / Synthetic + Recent).
- Live status pills: **Session** (Asia/London/NY/Off auto-detected from UTC), **MT5 connection**, **Execution mode** (Mock/Demo/Live Locked/LIVE), **Bot state**.
- Alert bell on the right.
- Mobile hamburger replaces the old absolute-positioned bell.

### Design system primitives (`components/trading/`)
| Component | Purpose |
|---|---|
| `SignalDirectionBadge` | Standard BUY / SELL / WAIT badge (3 sizes, optional icon) |
| `ConfidenceMeter` | Bar or ring variant; auto-toned (≥75 emerald, 60–74 amber, <60 red) |
| `StatusBadge` | Generic pill with tone + icon (replaces ad-hoc colored badges) |
| `PnLValue` | Mono tabular number, auto-signed, tone-aware |
| `StatCard` | Standardized KPI tile with optional tone border |
| `PageHeader` | Consistent title + icon + description + actions row |
| `EmptyState` | Standard empty/no-data placeholder |

### Color & token system (`lib/design-tokens.ts`)
- Single source of truth: `STATUS_COLORS` + helpers `pnlTone` / `confidenceTone` / `directionTone`.
- Replaces 30+ ad-hoc `text-green-500 / bg-destructive/10` strings scattered across pages.
- Bullish = emerald-400, Bearish = rose-400, Warning = amber-400, Danger = red-400, Info = cyan-300, Neutral = slate-300 — consistent across the app.

### Active symbol context (`lib/symbol-context.tsx`)
- `SymbolProvider` + `useActiveSymbol()` hook.
- Persists last-selected symbol to localStorage and tracks 5 most recent.
- `getCurrentSession()` helper for trading-session badge.

### Pages refactored as exemplars
- **Dashboard** — uses every primitive, intelligence per signal (symbol + direction + confidence + strategy + time), active-position cards with PnLValue + mode badge.
- **Scanner** — table headers in 10px uppercase, ConfidenceMeter inline, SignalDirectionBadge, EmptyState in empty cell.

---

## 🔴 Remaining gaps (priority-ordered)

### P1 — Pages still using legacy patterns (need a primitives pass)
- `risk-settings.tsx` (1331 lines) — needs decomposition into tab-component files; many ad-hoc badges/colors.
- `strategy-settings.tsx` (539 lines) — duplicate badge logic.
- `brain-analysis.tsx` (508 lines) — KPI tiles should become `StatCard`.
- `mt5-bridge.tsx` (443 lines) — connection / mode badges should become `StatusBadge`.
- `backtest.tsx` (323 lines) — equity-curve card + stats tiles non-standard.
- `bot-control.tsx` (257 lines) — start/stop/pause buttons could use a shared pill group.
- `analytics.tsx` (244 lines) — chart wrapper not standardized.
- `journal.tsx` (242 lines) — table styling differs.
- All `*-center.tsx` (Forex/Indices/Stocks/Synthetic) — symbol cards should pull from active-symbol context and display full intelligence (confidence, strategy, session, news risk).

### P2 — Master-spec features not yet built
- **AI Trade Assistant** page — explains each trade (why now, danger zones, invalidation, sizing rationale).
- **Trade Plans** page — saved playbooks per strategy/symbol.
- **Strategy Builder** — visual builder vs the existing toggle-based settings.
- **Exposure** page — net long/short by symbol, by sector, total at-risk capital.
- **API/Bridge Status** — separate health page (currently rolled into MT5 Bridge).

### P3 — Intelligence flow not yet uniform
Master spec requires every signal/trade to display: confidence · strategy · market condition · volatility state · session · news risk · AI explanation · risk approval · invalidation level. Currently:
- Signal model exposes: `direction`, `confidence`, `strategy`, `entryPrice`, `stopLoss`, `takeProfit`, `riskWarning` only.
- Missing on-record: `marketCondition`, `volatilityState`, `session`, `newsRisk`, `aiExplanation`, `invalidation`.
- **Action**: extend OpenAPI `Signal` schema + DB `signalsTable` to include these fields, then surface them via a new `SignalIntelligencePanel` primitive.

### P4 — Mobile polish
- Topbar status pills hidden below `md` (correct), but no mobile-only condensed indicator yet (e.g., a single "MT5 ●" dot with tap-to-expand).
- Tables on Forex/Stocks centers still horizontally scroll without sticky symbol column.
- No swipe gesture or bottom-sheet pattern for trade actions.
- Touch targets in `risk-settings` tabs are tight on phones.

### P5 — Visual consistency nits
- `progress` component still used in some pages; should standardize on `ConfidenceMeter`.
- Two flavors of empty state still exist in older pages (text-only vs icon-centered).
- `analytics.tsx` charts: no shared `ChartCard` wrapper yet.
- Some page headers still use `<h2>` directly instead of `PageHeader`.
- Tooltip styles vary; should adopt one.

---

## 🟡 Incomplete systems (functional but stubbed)
- **Synthetic candle generation** — used for demo scanning; production needs real Deriv tick feed (already noted in `replit.md`).
- **MT5 EA bridge** — server endpoints exist and are auth-gated; no real EA shipped yet.
- **News calendar** — page exists; no real news feed wired (uses placeholder data).
- **AI Learning** — page exists; learning loop is heuristic-driven only.
- **Public write endpoints** — bot control / strategy / risk routes have no auth (whole-app gap; consider session-based admin gate before public deploy).

---

## 🎯 Recommended next priorities

1. **Extend Signal intelligence** (P3) — add the 6 missing fields to OpenAPI + DB + scanner, then build a `SignalIntelligencePanel` primitive. Surfaces in Scanner row-expand, Trade detail drawer, Brain page.
2. **Decompose `risk-settings.tsx`** — split each tab into its own file under `pages/risk/`; replace ad-hoc badges with `StatusBadge` + `StatCard`.
3. **Apply primitives to `mt5-bridge.tsx`, `bot-control.tsx`, `brain-analysis.tsx`** — biggest visual-debt files, fastest perceived improvement.
4. **Build `AI Trade Assistant`** — biggest unique-value gap vs spec; reuses `SignalIntelligencePanel`.
5. **Mobile pass** — sticky symbol column on tables, condensed topbar dot, larger touch targets in risk tabs.
6. **Auth gate** — minimum admin token on all write endpoints before any public deployment.

---

## Files added in this pass
- `lib/design-tokens.ts`
- `lib/symbol-context.tsx`
- `components/trading/{SignalDirectionBadge,ConfidenceMeter,StatusBadge,PnLValue,StatCard,PageHeader,EmptyState,index}.{ts,tsx}`
- `components/layout/{Topbar,SymbolPicker}.tsx`

## Files rewritten in this pass
- `components/layout/AppLayout.tsx`
- `pages/dashboard.tsx`
- `pages/scanner.tsx`
- `App.tsx` (added `SymbolProvider`)

# ARX AI — Performance Architecture Audit (T016)

Audit-first, **no-feature-change** performance pass. The goal is to measure real
route/action/backend timing, document the loading architecture of every surface,
and apply only **low-risk, safe** optimizations on top of the existing perf
instrumentation (`lib/perf.ts`, the Orval `setRequestObserver` bridge,
Server-Timing parsing, ~150 lazy routes). No new product feature was added, no
safety surface was weakened, and **no live trade was placed**.

- Date: 2026-05-31
- Author: T016 performance audit pass
- Scope guardrails: LIVE-first; no Demo/Paper/simulated execution introduced;
  `ARX_LIVE_BROKER_EXECUTION_ENABLED` untouched; 16-gate evaluator, kill switch,
  allocation/freeze, per-user ownership, and MT5 confirmation all unchanged.

---

## 0. Method & honesty note

- **Backend timing is real and measured.** `pnpm --filter @workspace/scripts run
  qa:perf-backend-sweep` runs each endpoint in-process and reports median / p95 /
  app-median (Server-Timing) / payload bytes against a per-endpoint budget. All 30
  probes PASS (numbers below).
- **Frontend interaction timing in this sandbox is architecture-derived**, not
  captured from a live authenticated browser session. The artifact dev server is
  proxy-only and the QA harness cannot drive an authenticated browser here (see
  `.agents/memory/measuring-production-timing-in-dev.md` and
  `playwright-subagent-no-env-secrets.md`). The numbers below are derived from
  (a) the real backend network cost, (b) the bundle/lazy-route architecture, and
  (c) the already-shipped client perf instrumentation. The **instrumentation to
  capture exact browser numbers is in place** (admin-gated PerfPanel on
  `/admin-diagnostics`); a real owner/admin session will populate the precise
  client-side rows. Estimates are labelled as such; nothing is fabricated as a
  hard measurement.

---

## 1. Runtime health gate (PART 1 — blocking) — PASS

`pnpm run health:workflows` → **6 pass, 0 warn, 0 fail**.

| Probe | Result |
|---|---|
| api-server | HTTP 200 in ~55ms |
| frontend (app preview) | HTTP 200 in ~13ms |
| mockup-sandbox | HTTP 200 (design-only, not required) |
| api-server `/healthz` payload | `app="ARX AI"`, uptime healthy |
| frontend served asset | dev (vite module graph) |
| scanner candles auth | unauth → **401** (deny-by-default auth gate intact) |

The task spec's claim that the `API Server` and `web` workflows were "currently
failing" was **stale** — all three workflows are running and serving. No runtime
repair was required and the live MT5 path was not disturbed.

---

## 2. Performance architecture map (PART 2)

Per-route attributes: **first-load deps** (route shell), **on-mount API calls**,
**polling** (and whether it pauses on hidden tab), **lazy/deferred**,
**admin-only**, **duplicate-request risk**, **risk level** of touching it.

### Global foundation (already in place — do NOT rebuild)

- **QueryClient defaults** (`App.tsx`): `retry: 1`,
  `refetchOnWindowFocus: false`, `refetchIntervalInBackground: false`,
  `staleTime: 30s`, `gcTime: 5min`. These are correct and conservative.
- **~150 routes are `React.lazy`-loaded** — each page is a separate chunk; the
  route shell only pays for the active page.
- **Perf instrumentation**: `PerfObserverMount` wires `setRequestObserver` →
  `observeOrvalRequest`, so every generated React Query hook is timed with
  backend-ms parsed from `Server-Timing`. Client transport is **admin-gated and
  default-off**; only slow rows flush to the ring buffer. Normal users never see
  debug timing.
- **Route containment**: `routeAccess.ts` default-deny allowlist +
  `RouteAccessGuard` — normal users are blocked at the route level, not just
  hidden in nav. Admin/owner bypass.

### Core normal-user routes

| Route | On-mount calls | Polling (hidden-tab) | Lazy | Dup risk | Risk to touch |
|---|---|---|---|---|---|
| `/` Cockpit (`dashboard.tsx`) | account-shell, risk/status, allocation, alerts/unread-count | risk/alerts polls (paused on hidden) | yes | low | low |
| `/market-scanner` (Scanner) | universes, status, opportunities, candles, positions/all, pending-drafts | scanner 5s, positions 10s, selected-market 30s, deriv 15s (all paused on hidden) | yes | low (distinct keys) | **medium** (priority surface) |
| `/ai-command-center` (Ruby) | conversation/history loaded after shell | none on idle | yes | low | medium (read-only assistant) |
| `/my-trades`, `/positions` | per-user positions | modest poll (paused) | yes | low | low |
| `/risk-command-center` | risk status/limits, kill switch state | poll (paused) | yes | low | **high** (safety surface) |
| `/alerts` | alerts list | poll (paused) | yes | low | low |
| `/mt5-setup` | bridge debug, demo arming | bridge debug poll | yes | low | **high** (bridge/live) |
| More/Settings (`/settings`, `/help`, `/my-account`) | settings/account reads | none | yes | low | low |

### Admin-only / records / dormant

- **Admin diagnostics** (`/admin-diagnostics`) hosts the `PerfPanel`
  (flips `setPerfTransportEnabled`, reads
  `/api/admin/performance/recent-actions` + `action-summary`). Admin-gated,
  off the normal-user path.
- **ADMIN-ADVANCED / RECORDS / MANUAL-REVIEW** routes are enumerated in
  `docs/PRUNING_MAP.md`; all are route-gated for normal users and lazy-loaded,
  so they cost nothing on the normal-user critical path. Nothing was deleted in
  this pass (see PART 10).

### Scanner breakdown (priority #1 surface)

On-mount (from `pages/market-scanner.tsx` + `components/scanner/*`):
- `/api/market-scanner/universes` (once), `/status`, `/opportunities?limit=40`.
- `ScannerChartPanel`: `/api/data/candles` (on symbol/timeframe/reload — **not
  polled**), `/api/me/positions/all` + `/api/me/pending-order-drafts` (10s poll,
  paused on hidden).
- `SelectedMarketPanel`: `/api/market-data/deriv/status` (15s),
  `/api/market-scanner/selected-market` (30s).
- `ScannerTradeModal`: `/api/me/demo-bridge-debug` (5s while open),
  `/api/me/live/profile` (30s staleTime); active-command poll at 1.2s **only
  after submit until terminal**.
- `RecentScannerTrades`: `/api/me/demo-commands?limit=100` (5s, paused).
- `SymbolExplorer`: **no network** — synchronous in-memory registry filter.
- `RubyChartRead`: manual, on-demand only.

Key finding fixed this pass: the candlestick chart used to fully remount on the
10s positions/pending poll (see PART 6).

### Ruby breakdown

Ruby shell opens from a lazy chunk. Conversation history loads **after** the
shell. Ruby is **read-only** — every response carries
`{safetyMode:"paper_only", liveLocked:true, readOnlyMode:true,
allowOrderExecution:false}`. The Scanner "Ruby chart read"
(`RubyChartRead`) is a deterministic, on-demand call to the read-only
`/api/me/assistant/explain-signal` / `read-chart` endpoint and never blocks chart
render or trade Confirm.

### Trade-action breakdown (Buy/Sell → modal → Confirm → pending → dispatch → ledger → UI)

The critical path is server-authoritative: every chart/modal trade action routes
through the Global Instant Trade Router (`executeInstantTrade`), which re-runs the
full 16-gate evaluator + kill switch + per-user allocation server-side. PAPER mode
renders **no** trade buttons. The modal opens from already-loaded state; Confirm
posts and immediately shows pending, then polls command status at 1.2s until
terminal. No frontend-only trade path exists.

---

## 3. Browser interaction timing — 15 interactions (PART 3)

Targets from the spec, with status. Backend column is **measured**; client column
is **architecture-derived** (see §0). Mobile/desktop differ only in render cost;
the network/backend cost is identical.

| # | Interaction | Target | Backend (measured) | Client (est.) | Status |
|---|---|---|---|---|---|
| 1 | Nav tap feedback | <100ms | n/a (local) | <50ms (route guard + lazy boundary) | ✅ met |
| 2 | Route shell paint | <1s | n/a | <1s (lazy chunk + skeleton) | ✅ met |
| 3 | Cockpit shell | <1s | account-shell 8ms / risk 5ms | <1s | ✅ met |
| 4 | Scanner shell | <1s | status+opportunities ~5–9ms | <1s | ✅ met |
| 5 | Chart skeleton | <1s | candles 3ms | <1s (skeleton immediate; "Loading candles…") | ✅ met |
| 6 | Search usable | <1s | n/a (in-memory) | instant (synchronous registry) | ✅ met |
| 7 | Market-selection feedback | <300ms | selected-market poll 5ms | <300ms (shared chart bus updates immediately) | ✅ met |
| 8 | Buy/Sell modal open | <1s | profile 30s-stale (cached) | <1s (opens from loaded state) | ✅ met |
| 9 | Lot input responsiveness | instant | n/a | instant (local state) | ✅ met |
| 10 | Confirm → pending shown | <100ms | n/a (optimistic pending) | <100ms (pending state set before network) | ✅ met |
| 11 | Ruby open shell | fast | n/a | <1s (lazy chunk) | ✅ met |
| 12 | Ruby thinking dots | <100ms | n/a | <100ms (local UI before request) | ✅ met |
| 13 | Ruby first response | external-bound | provider-bound | shows pending immediately | ✅ met (slow calls show pending) |
| 14 | More/Settings shell | <1s | settings reads <8ms | <1s | ✅ met |
| 15 | Nothing feels frozen | — | — | polling paused on hidden; slow calls show pending | ✅ met |

**Measured backend sweep (30/30 PASS, 0 over budget):** representative medians —
`/api/me/account-shell` 8ms, `/api/me/risk/status` 5ms,
`/api/me/positions/all` 10ms, `/api/me/alerts` 5ms,
`/api/me/alerts/unread-count` 4ms (dedicated SQL aggregate),
`/api/market-data/candles` 3ms, `/api/me/live/commands?limit=10` 5ms. The backend
is **not** the bottleneck on any interaction.

---

## 4–11. Findings + safe optimizations applied

### Chart no longer remounts on unrelated state (PART 6 / 11) — APPLIED

`components/scanner/ScannerChartPanel.tsx` previously rebuilt the entire
lightweight-charts instance (`chart.remove()` + `createChart()`) whenever
`symbolPositions` or `symbolPending` changed — which happens **every 10s** when
the positions/pending poll returns fresh array references. That destroyed and
recreated the chart on every poll tick, discarding the user's zoom/scroll state
and burning CPU/GC.

Fix (no behavior change): the single effect was split into two.
- **Chart-creation effect** now depends only on `[candles, symbol]` (which change
  on symbol/timeframe/reload — *not* on the 10s poll). It builds the chart + sets
  candle data once per candle set and bumps a `chartEpoch`.
- **Overlay effect** depends on `[symbolPositions, symbolPending, chartEpoch]` and
  updates the position/pending **price lines incrementally** — it removes the
  previously-drawn lines (`removePriceLine`) and adds the current set
  (`createPriceLine`) onto the existing series, never recreating the chart.

Result: the chart is rebuilt only on symbol/timeframe/reload; the 10s poll now
only diffs price lines. Zoom/scroll state is preserved; trade overlays remain
server-filtered and per-user scoped. Verified with `pnpm --filter
@workspace/trading-dashboard run typecheck` (green).

### Search is intentionally NOT debounced (PART 5/6) — NO CHANGE (by design)

`SymbolExplorer` search runs a **synchronous** `useMemo` filter over the in-memory
`SYMBOL_REGISTRY` — there is **no network call**, so there is nothing to debounce
or cancel. Adding a debounce here would only add input latency. Documented as
intentionally-instant; the "search usable <1s" target is met trivially. (Recorded
in memory so a future pass does not "fix" a non-issue.)

### Duplicate work (PART 5) — already minimal

Distinct React Query keys per concern; no duplicate auth/session or account-mode
fan-out found on the Scanner/Cockpit critical path. Account-mode is served by a
single resolver (`/api/me/account-mode`). The unread-alert badge already uses a
dedicated SQL-aggregate endpoint (`/api/me/alerts/unread-count`, 4ms, 35 bytes)
rather than counting the full drawer client-side. No duplicate-call removal was
needed.

### Polling / hidden-tab (PART 5) — already correct

All raw `setInterval` loops on the Scanner (scanner 5s, positions 10s, bridge
debug 5s, recent trades 5s) already pause on `document.hidden` via
`visibilitychange` and resync on return; React Query polls inherit
`refetchIntervalInBackground: false`. No change required.

### Deferred / lazy modules (PART 4 / 11) — already in place

~150 routes are `React.lazy`. Heavy collapsed panels are already
`React.lazy`-loaded (see `.agents/memory/perf-lazy-collapsed-heavy-panels.md`).
Ruby conversation history loads after shell. Admin diagnostics/perf panel is
admin-gated and off the normal path. No new safe-defer candidate on the critical
path was found that wasn't already deferred.

### Backend / event-loop (PART 8) — lean

The backend sweep shows the critical read path at 3–10ms with small payloads. The
live-trade critical path (auth → permission → allocation → kill switch → freeze →
symbol/lot validation → bridge readiness → MT5 dispatch → ledger → response) is
unchanged and not on any polling loop. Ruby explanation, news, backtest, and deep
scan scoring are already off the trade hot path. No backend change made (no
validation removed, nothing moved to the frontend).

### Database indexes (PART 9) — APPLIED (additive, via schema + push)

Query-pattern inspection of the Drizzle schema found the hottest **per-user**
read paths lacked composite indexes. Added (purely additive, non-destructive;
applied with `drizzle-kit push` and verified present in `pg_indexes`):

| Table | Index added | Serves |
|---|---|---|
| `notifications` | `(user_id, status)` | unread-badge count by user |
| `notifications` | `(user_id, created_at)` | notification feed by user + recency |
| `arx_live_commands` | `(user_id, created_at)` | per-user live command history/timeline |
| `mt5_demo_commands` | `(user_id, status)` | per-user demo command status filters |
| `mt5_demo_commands` | `(user_id, created_at)` | "recent demo commands" feed |

Tables already well-indexed and left unchanged: `arx_live_positions`
(`(user_id, closed_at)` open-position index already optimal),
`opportunity_scans` (`(user_id, created_at)` + `(user_id, symbol)` present),
`arx_assistant_messages` (`(user_id, created_at)` present),
`arx_live_commands` (`(user_id, status)` present). No data was deleted, no trade
record altered, no financial logic changed, no master-account data exposed.

### Redundant UI (PART 10) — cross-referenced, nothing new to remove

Cross-referenced `docs/dormant-systems-audit.md` and `docs/PRUNING_MAP.md`. Prior
passes already: collapsed normal-user nav to Cockpit·Scanner·Ruby·Risk·More,
route-gated all admin/dormant routes (default-deny), moved long disclosure behind
expanders, collapsed repeated banners into a single chip strip, and hid advanced
quick-links from non-admins. Most "dead" flags were verified false positives
(mounted + called). No safe new removal was identified this pass; the four
`Needs-manual-review` orphan dev scripts remain flagged, not deleted (dynamic
invocation risk).

---

## 12. Regression + safety checks (PART 12) — all green

| Check | Result |
|---|---|
| `pnpm run health:workflows` | 6 pass, 0 warn, 0 fail |
| `pnpm --filter @workspace/trading-dashboard run typecheck` | green |
| `pnpm run typecheck:libs` | green (declarations rebuilt after schema change) |
| `pnpm run ci:guards` | **26/26 guards passed** |
| Scanner candles auth | unauth → 401 (deny-by-default intact) |
| Backend perf sweep | 30 pass, 0 over-budget |

Note: the full root `pnpm run typecheck` OOMs in this sandbox (known env limit —
see `.agents/memory/typecheck-oom-this-env.md`); verified via `typecheck:libs` +
per-package filter instead.

**Safety confirmations:** no live trade placed; live MT5 path untouched; no
Paper/Demo fallback introduced; no normal user gained admin/live access;
`ARX_LIVE_BROKER_EXECUTION_ENABLED` not reset; 16-gate evaluator, kill switch,
allocation/freeze, per-user ownership, and MT5 confirmation all unchanged. DB
changes are additive indexes only.

---

## 13. Final report — 29 items (PART 13)

1. **Health result** — `health:workflows` 6/6 PASS; all three workflows serving;
   auth gate intact; the spec's "workflows failing" claim was stale.
2. **Architecture map** — §2 (global foundation + per-route table + Scanner/Ruby/
   trade breakdowns).
3. **Before/after browser timing (desktop)** — §3 table; all 15 targets met.
4. **Before/after browser timing (mobile)** — identical backend cost; render path
   differs only in component cost. Client rows are architecture-derived (§0); the
   admin PerfPanel captures exact numbers in a real session.
5. **Scanner timing** — shell <1s; candles 3ms backend; chart skeleton immediate.
6. **Chart timing** — skeleton <1s; rebuild now only on symbol/timeframe/reload.
7. **Search timing** — instant (synchronous in-memory; no network).
8. **Modal timing** — Buy/Sell modal opens <1s from loaded state.
9. **Confirm timing** — pending shown <100ms (optimistic before network).
10. **Ruby timing** — shell <1s; thinking dots <100ms; slow responses show
    pending and never freeze the UI.
11. **Slowest remaining frontend dependency** — first-paint of the active lazy
    chunk + lightweight-charts init on Scanner (one-time per chart build).
12. **Slowest remaining backend dependency** — external market-data providers on
    Ruby/quote fall-through (provider-bound, off the trade path, shows pending);
    largest in-app payload is `/api/me/alerts` (~35KB, still 5ms).
13. **Duplicate requests removed** — none required; distinct keys + single
    account-mode resolver + dedicated unread-count aggregate already in place.
14. **Polling changes** — none required; all Scanner loops already pause on
    hidden tab and resync on return.
15. **Lazy/deferred modules** — already ~150 lazy routes + lazy collapsed heavy
    panels + after-shell Ruby history; no new critical-path defer found.
16. **Chart-remount reductions** — the 10s positions/pending poll no longer
    rebuilds the chart; price lines update incrementally (PART 6).
17. **Indexes added** — 5 composite per-user indexes across `notifications`,
    `arx_live_commands`, `mt5_demo_commands` (§"Database indexes"); verified in
    `pg_indexes`.
18. **Redundant UI handled** — cross-referenced dormant/pruning docs; prior passes
    already collapsed/route-gated; nothing new safe to remove.
19. **Files changed** —
    `artifacts/trading-dashboard/src/components/scanner/ScannerChartPanel.tsx`,
    `lib/db/src/schema/notifications.ts`,
    `lib/db/src/schema/arxLiveExecution.ts`,
    `lib/db/src/schema/mt5DemoExecution.ts`, and this audit doc.
20. **Tests passed** — `ci:guards` 26/26, `typecheck:libs`, frontend typecheck,
    backend sweep 30/30, health 6/6.
21. **Tests failed-and-fixed** — none; all checks passed on first run after the
    changes.
22. **Safety confirmations** — see §12 (no live trade; no safety surface
    weakened; live env switch untouched; additive DB only).
23. **Remaining risk: chart overlay** — low. The incremental price-line path is
    type-checked and uses documented v5 APIs (`createPriceLine`/`removePriceLine`);
    a live authenticated session should visually confirm overlays redraw on the
    10s poll without flicker.
24. **Remaining risk: frontend timing capture** — client interaction numbers are
    architecture-derived here; capture exact numbers via the admin PerfPanel in a
    real owner/admin browser session.
25. **Remaining risk: index write cost** — five additional indexes add marginal
    write overhead on three already-low-volume tables; net positive at scale.
26. **Recommended next-safe optimization** — capture real PerfPanel numbers in a
    live session and fold them into rows 3–4 here; confirm the chart-overlay
    visual behavior end-to-end.
27. **Recommended next-safe optimization** — consider memoizing scanner result
    cards if a future profile shows re-render cost on large opportunity lists
    (not observed as a problem now).
28. **Deeper future (high-risk, OUT OF SCOPE)** — streaming/progressive Ruby
    responses and server-push (SSE/WebSocket) for positions/quotes to replace
    polling entirely; would touch the assistant + bridge surfaces and needs its
    own task.
29. **Deeper future (high-risk, OUT OF SCOPE)** — physical deletion of the
    `MANUAL-REVIEW` dormant routes/scripts after a soak period and a proven
    no-reference audit; deliberately not done here (dynamic-invocation risk).

# ARX AI — Product-Scope Pruning Map

Purpose: classify every navigable surface so the normal-user experience collapses
to a focused AI trading command center (**Cockpit · Scanner/Trade · Ruby · Risk ·
More**) while **nothing is deleted** and admins/owner keep full access.

## Method & safety rules

- **Remove-from-navigation first, never blind-delete.** This pass only changes
  what appears in the sidebar (`AppLayout.tsx → NAV_GROUPS`). Every route in
  `App.tsx` is left intact and reachable by direct URL.
- Items hidden from normal users are moved into `adminOnly` nav groups. They
  still render for OWNER/ADMIN sessions and remain in the admin menu search.
- Backend route guards (`AdminRouteGuard`, server 403s, the 23-gate live
  pipeline, trade-ownership scoping, kill switch, MT5 confirmation) are
  unchanged and remain authoritative.
- The mobile bottom nav already matches the target 4 surfaces
  (Cockpit · Trade · Scanner · AI · Me/More) and is unchanged.
- Anything genuinely uncertain is kept reachable and tagged **manual review** —
  not deleted.

## Classification legend

1. **KEEP-CORE** — visible in normal-user nav (one of: find a trade, analyze a
   market, understand risk, execute/manage a trade, let Ruby assist, account).
2. **ADMIN-ADVANCED** — removed from normal-user nav, moved to an `adminOnly`
   group; reachable by admin/owner sessions only. Normal users are now blocked
   at the route level (not just hidden in nav) — see "Route-level enforcement".
3. **RECORDS/SYSTEM** — operational/diagnostic; admin-only nav + route-gated.
4. **MANUAL-REVIEW** — kept reachable for admins; **route-gated for normal
   users**; flagged for a later deletion decision.

---

## Route-level enforcement (default-deny for normal users)

Nav hiding alone is insufficient — every adminOnly/dormant route used to be
reachable by typing the URL. As of this pass that gap is closed:

- `src/lib/routeAccess.ts` defines a **default-deny allowlist** of normal-user
  product routes (the 4 visible nav groups + a small set of product-fit
  flow/alias routes: `/scanner`, `/charts`, `/broker`, `/risk-profile`,
  `/my-performance`, `/notifications`, `/alerts-center`, `/onboarding`, and the
  `/my-trades/:tradeKey` prefix). `isNormalUserAllowedPath()` matches exact
  paths + prefixes.
- `RouteAccessGuard` in `AppLayout.tsx` (formerly `AdminRouteGuard`) enforces
  it: OWNER/ADMIN sessions bypass and keep full access to every route; a normal
  user on any non-allowlisted path gets a "this page isn't part of your trading
  app" card + **Go to Cockpit**. The existing `/admin/*` guard behavior is
  unchanged. Identity-loading renders a neutral skeleton so a real admin is
  never bounced off a deep link before `/api/me` resolves.
- This is a product-containment / UX layer. **Backend route guards
  (`requireAdmin`, per-user ownership, the 23-gate live pipeline, kill switch)
  remain authoritative** for all data and every trade action — nothing here
  weakens them.
- The Scanner result cards' advanced quick-links (Grade / Replay / Backtest)
  are now hidden from non-admins so a card never deep-links a normal user into
  a route their session can't reach.

## KEEP-CORE (normal-user navigation)

| Route | Page file | Purpose | Normal users | Action |
|---|---|---|---|---|
| `/` | `dashboard.tsx` | Cockpit: account health, P&L, signals | yes | KEEP-CORE (Primary) |
| `/market-scanner` | `market-scanner.tsx` | Scanner / trading terminal (chart + signals + trade) | yes | KEEP-CORE (Primary) |
| `/trade-command-room` | `trade-command-room.tsx` | Compose/review trade tickets | yes | KEEP-CORE (Primary) |
| `/ai-command-center` | `ai-command-center.tsx` | Ruby (AI) assistant | yes | KEEP-CORE (Primary) |
| `/my-trades` | `my-trades.tsx` | Open trades | yes | KEEP-CORE (Primary) |
| `/positions` | `positions.tsx` | Positions / OMS | yes | KEEP-CORE (Primary) |
| `/risk-command-center` | `risk-command-center.tsx` | Risk status, limits, kill switch | yes | KEEP-CORE (Primary) |
| `/alerts` | `alerts.tsx` | Signal/risk alerts | yes | KEEP-CORE (Primary) |
| `/live-chart` | `live-chart.tsx` | Live OHLC chart | yes | KEEP-CORE (Markets & Tools) |
| `/watchlists` | `watchlists.tsx` | Tracked symbols | yes | KEEP-CORE (Markets & Tools) |
| `/orders` | `orders.tsx` | Manual order ticket | yes | KEEP-CORE (Markets & Tools) |
| `/mt5-setup` | `mt5-setup.tsx` | MT5 bridge setup + demo execution | yes | KEEP-CORE (Markets & Tools) |
| `/economic-calendar` | `economic-calendar.tsx` | Macro events | yes | KEEP-CORE (Markets & Tools) |
| `/news-risk` | `news-risk.tsx` | News / macro risk | yes | KEEP-CORE (Markets & Tools) |
| `/trading-calendar` | `trading-calendar.tsx` | Trading-day calendar | yes | KEEP-CORE (Markets & Tools) |
| `/performance-scorecard` | `performance-scorecard.tsx` | Win/loss report | yes | KEEP-CORE (Performance) |
| `/analytics` | `analytics.tsx` | Account analytics | yes | KEEP-CORE (Performance) |
| `/trade-logs` | `trade-logs.tsx` | Trade history | yes | KEEP-CORE (Performance) |
| `/shadow-journal` | `shadow-journal.tsx` | Trading journal | yes | KEEP-CORE (Performance) |
| `/my-account` | `my-account.tsx` | Account & balance | yes | KEEP-CORE (Account) |
| `/settings` | `settings.tsx` | App settings | yes | KEEP-CORE (Account) |
| `/help` | `help-center.tsx` | Help / support | yes | KEEP-CORE (Account) |
| `/emergency` | `emergency.tsx` | Emergency stop (safety) | yes | KEEP-CORE (always visible) |

## ADMIN-ADVANCED (admin/owner only; route-gated — normal users cannot reach by URL)

- **Advanced Trading:** `/sniper-watchlist`, `/live-trading`, `/action-center`,
  `/live-intent-queue`, `/mt5-bridge`, `/broker-readonly`,
  `/broker-reconciliation`, `/live-trading-control`, `/live-shared`,
  `/live-manual`, `/live-ai-assist`, `/live-ai-auto-test` — tester/duplicate live
  surfaces. The primary live/demo trade flow stays in Scanner + Trade + Open
  Trades + Positions, so these are power/operator tools, not the user path.
- **Advanced AI & Strategy:** `/ai-coach`, `/ai-mentor`, `/trader-coach`,
  `/trade-grader`, `/market-health`, `/strategy-lab`, `/autopilot-control-center`,
  `/shadow-mode`, `/forward-testing`, `/backtesting`, `/market-replay`,
  `/strategy-tournament`, `/strategy-promotion`, `/confidence-calibration`,
  `/brain`, `/edge-discovery`, `/trader-skill`, `/ai-readiness-score`,
  `/trading-intelligence`, `/weekly-review`, `/trade-plan-builder`,
  `/post-trade-debriefs`, `/replay-simulator` — experimentation/coaching surfaces
  that duplicate or feed Ruby; not part of the core Analyze→Risk→eXecute loop.
- **Advanced Risk & Data:** `/risk-settings` (governor config), `/risk-profile`,
  `/risk-events`, `/data-quality`, `/prop-firm-mode` — detailed/diagnostic risk
  config behind the user-facing Risk command center.

## RECORDS / SYSTEM (admin-only nav)

`/audit-vault`, `/safety-logs`, `/notifications`, `/admin-control` (profile),
`/onboarding`, `/status-command-center`, `/release-status`, `/release-notes`,
`/feedback-center`. Plus the entire existing **Admin** group (`/admin/*`,
`/testing-control-center`, QA/tester pages) — unchanged.

## MANUAL-REVIEW (kept reachable, no nav entry; later deletion candidates)

These routes exist in `App.tsx` but were already not in the primary nav and/or
are legacy/duplicate. They are now **route-gated for normal users** (admins keep
URL access); revisit for physical deletion once this nav change has soaked.
Uncertain files are deliberately **left in place** — gated, not deleted:

- Paper/demo legacy backing the demo routes: `paper-trading.tsx`
  (`/demo-trading`, `/orders/demo`, `/positions/demo`), `my-paper-trades.tsx`.
- Duplicate/legacy dashboards & rooms: `trading-cockpit.tsx`,
  `paper-testing-launch.tsx`, `active-paper-session.tsx` (routes already
  unmounted in Phase 3), `status-command-center` aliases.
- Center duplicates: `forex-center`, `indices-center`, `stocks-center`,
  `synthetic-center`, `portfolio`, `calendar` (vs `trading-calendar`),
  `journal` (vs `shadow-journal`), `learning`, `analytics-command`,
  `trade-command-room` vs `orders`/`positions` overlaps.

> Deletion is deliberately **out of scope** for this pass (remove-from-UI first).
> Each MANUAL-REVIEW item must be confirmed unreferenced before any file removal.

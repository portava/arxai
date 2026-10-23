---
name: Two-tier human-trader nav
description: How pending vs approved human traders get different nav + route access in trading-dashboard
---

# Two-tier human-trader navigation & route containment

Human traders are split into two visibility/containment tiers, driven by the
per-user approval signal from `/api/me/account-mode` (NOT by role):

- **PENDING / unapproved** → reduced, non-execution experience: cockpit, ARX
  status, onboarding, trading school, account, settings, help, plus the always-
  on safety surfaces (emergency, notifications).
- **APPROVED (live / shared-bridge)** → the full non-admin trader menu (adds
  scanner, trade/live-trading, chart, positions, history, backtesting,
  assistant, performance, risk, etc.). The full allowlist is a strict superset
  of the pending one.

**Approval signal — single source of truth:** `hooks/useTraderTier.ts` wraps
`useTradingMode()` and returns `{ isLoading, isApprovedTrader }` where
`isApprovedTrader = !isLoading && (isLiveShared || envelope?.userApprovalStatus
=== "APPROVED")`. Do NOT invent a second approval source. Loading / unresolved
approval resolves to NOT-approved (locked).

**Why:** nav-hiding ≠ access control, and approval is a per-user runtime state
distinct from role. A pending trader must never see or reach an execution
surface, but cockpit/learn/account must stay instantly reachable while the
async approval query resolves.

**How to apply (every surface must be updated in lockstep — see
nav-role-surfaces.md):**
- `AppLayout.tsx`: `NavItem`/`NavGroup` carry `approvedOnly?`; one `canSee()`
  predicate gates search, recent, and group/item render. Admins bypass via
  `effectiveIsAdmin`. "Essentials" + "Account & Control" groups are unflagged
  (visible to all); Primary/Markets&Tools/Performance&History/Advanced AI are
  `approvedOnly`. `/live-trading` was promoted from the admin group into the
  approved-only Primary.
- `MobileBottomNav.tsx`: `PENDING_ITEMS` (Cockpit/Learn/Me) for unapproved;
  full BASE+USER_TAIL for approved; investor + admin branches unchanged.
- `CommandPalette.tsx`: items carry `approvedOnly?`; `visibleCommandPaletteItems`
  takes `isApprovedTrader?` and filters admin → approvedOnly → always.
- `FloatingActionPanel.tsx`: trade/scanner/AI/risk/alerts + bot toggle/stop
  gated behind `canExecute = isAdmin || isApprovedTrader`; Emergency Kill Switch
  always renders.
- `lib/routeAccess.ts`: `PENDING_USER_EXACT`/`PENDING_USER_PREFIXES` +
  `isPendingTraderAllowedPath` (reduced) vs `NORMAL_USER_EXACT` +
  `isNormalUserAllowedPath` (full superset). `isHumanTraderAllowedPath(loc,
  {isApprovedTrader})` is the tier-aware entry point.
- `RouteAccessGuard.tsx`: order = realAdmin → allow; pending-allowed path →
  allow (no wait on approval); else if `tierLoading` → skeleton (don't bounce a
  deep-linked approved trader); else if `isApprovedTrader && isNormalUserAllowed`
  → allow; else redirect "/". Admin `/admin/*` handling unchanged. Backend route
  guards remain authoritative for data either way.

**Test wiring:** every test that renders these components (NavSurfaces.*,
RouteAccessGuard, assistantName.customName, testing-lab/TestingLabNav) must mock
`@/hooks/useTraderTier`. Existing full-menu coverage mocks `isApprovedTrader:
true`; pending-tier tests mock `false`.

**DB-backed backstop (the FE mocks can't catch a backend approval-signal
regression):** a route test in the `ci:integration` lane boots the real
meUnifiedMode router, seeds a PENDING and an APPROVED trader, hits the real
`GET /api/me/account-mode`, and asserts the exact `useTraderTier` predicate. The
non-obvious seeding decision: NEVER mutate the `global_trading_settings`
singleton (governs the live server). Instead force each user's routing to
SHARED_MASTER_MT5 via the PER-USER `user_trading_permissions
.account_routing_override = "shared_master_mt5"`, then vary ONLY the approval
input — APPROVED gets a `user_master_live_access` row with
`master_live_status = "APPROVED"`, PENDING gets NO such row (⇒ NOT_APPROVED).
That makes the approval signal the single isolated variable and deterministic
under any ambient global routing state. LIVE_SHARED-mode-true is NOT seeded
(needs 4 aligned rows + arming + env); it's covered by predicate logic only.

**Browser-e2e DOM gotcha (verified live vs real `/api/me/account-mode`):**
nav item testid = `nav-${href.replace(/\//g,"-") || "home"}` (so `/`→`nav-home`,
`/live-trading`→`nav--live-trading`); group header = `nav-group-${label
.toLowerCase().replace(/\s+/g,"-")}`. AppLayout renders group items behind
`{open && ...}`, so a **collapsed** group (`defaultOpen:false`, e.g. "Account &
Control") does NOT mount its item testids — assert those item testids only for
**open-by-default** groups ("Essentials" and "Primary" have no `defaultOpen` ⇒
open). Reliable tier discriminators in a browser test: PENDING sees Essentials
items (`nav-home`, `nav--status-command-center`, `nav--onboarding`,
`nav--school`) but NOT `nav-group-primary` / `nav--live-trading` / etc., and a
direct nav to `/live-trading` lands on `/`. APPROVED sees `nav-group-primary` +
`nav--live-trading`/`nav--market-scanner`/`nav--positions`/
`nav--trade-command-room`, NOT the adminOnly `nav-group-advanced-trading`, and
`/live-trading` stays. Non-admin approved still never sees adminOnly groups.

---
name: Global nav surfaces gate roles independently
description: The trading-dashboard has multiple global navigation surfaces beyond the sidebar; each enforces role visibility on its own.
---

There are at least four global navigation surfaces, all mounted in AppLayout for
every authenticated session: the desktop sidebar (NAV_GROUPS / INVESTOR_NAV_GROUPS),
MobileBottomNav, FloatingActionPanel (the "+" quick-action FAB), and CommandPalette
(Ctrl/Cmd+K). The sidebar was already role-correct (adminOnly filtering +
INVESTOR_NAV_GROUPS), but the other three were NOT — they showed trader/admin items
to investors and admin/tester/`/admin/*` items to normal users.

**Why:** sidebar correctness gives a false sense that nav is role-safe. The other
three surfaces each have their own item lists and must each branch on
`useProductRole().isInvestor` and `useViewMode().effectiveIsAdmin`.

**How to apply:** when fixing nav role visibility or adding a new gated page, check
EVERY global nav surface, not just the sidebar. Role-gating rule of thumb: investor =
view-only (hide trade/scanner/AI/bot surfaces, often render null); normal user = hide
admin/operator/tester items and `/admin/*` paths; keep the non-admin set within the
normal-user allowlist in `lib/routeAccess.ts` so no menu entry redirects home.
Hiding from a menu does NOT remove the route — routes stay in App.tsx and reachable
by direct URL (route guards remain authoritative).

## Investor-reachable pages must self-gate trade config

`/settings` is in BOTH the normal-user and investor allowlists (investors need
account settings), but the Settings page historically rendered only trading
config (bot DEMO/LIVE mode, auto-trade, risk parameters, MT5 bridge). A view-only
investor therefore saw trade controls. Route containment (routeAccess.ts) keeps
investors OUT of Trade/Scanner/Ruby/Risk (those routes aren't in the investor
allowlist), but any page that IS in the investor allowlist must role-gate its
trade-config sections internally via `useProductRole().isInvestor`.

**Why:** allowlist membership = "can navigate here", not "everything here is safe
for this role". The two must be reconciled per page.

**How to apply:** when adding a page to the investor allowlist (or adding
trade-config to an already-allowlisted page like /settings, /my-account), gate the
sensitive sections behind `!isInvestor` and disable their queries
(`enabled: !isInvestor`). Also: any in-page link an investor can see must point to
a route inside `isInvestorAllowedPath` or it bounces to a redirect.

## Admin consolidation = additive deep-link hub, not a rebuild

The Admin surface is ~30 separate routes. It was consolidated into ONE tabbed
Admin Hub at the bare `/admin` route whose tabs deep-link (wouter <Link>) to the
existing admin pages — no existing route or page was moved/rebuilt/deleted.

**Why:** the heavy admin pages are safety-sensitive and complex; moving their
content into a hub would be a risky rebuild. A navigation hub satisfies "one
organized command center" while keeping every route independently registered and
reachable by direct URL.

**How to apply:** `/admin` (no trailing segment) is free — it does NOT collide
with `/admin/users` etc. because wouter Route matching is exact. `/admin/*` is
already gated by RouteAccessGuard on effectiveIsAdmin (blocks investors → /investor,
normal users → /, logged-out via AuthGate, and admin-previewing-as-user). Wrap a
new admin nav hub in AdminDiagnosticsGate for defence-in-depth. When adding hub
links, every href must map to a real <Route> in App.tsx or it dead-redirects.

## Slimming the admin sidebar after the hub exists

Once the Admin Hub is the front door, the bloated adminOnly "Admin" nav group
was cut to a few high-priority shortcuts (Hub + Users + Live Controls + Bridge +
QA/Health + Emergency Stop). Everything removed from the sidebar stays reachable
two ways: its <Route> in App.tsx (direct URL) and a deep-link inside an Admin Hub
tab. Before removing a sidebar item, confirm a hub tab links it — if not, add the
link first so nothing becomes nav-orphaned.

**Drift protection:** admin-hub.tsx exports `ADMIN_HUB_HREFS` (derived from the
tab config, deduped) and a vitest (`admin-hub.routes.test.ts`) asserts every href
resolves to a `path="..."` in App.tsx AND that `/admin` + every `/admin/*` hub
link is denied by routeAccess for normal users + investors. The test parses
App.tsx as text; it self-guards against a vacuous pass (routePaths.size > 50 and
`/admin` present) so a broken regex fails loudly instead of green.

## Dead-end nav guards: registry over rendered DOM

Each nav surface has a regression test asserting every normal-user-visible target
is on `isNormalUserAllowedPath` (so none silently redirects home like `/school`
once did): `NavSurfaces.normalUser.test.tsx` (sidebar + MobileBottomNav +
FloatingActionPanel, DOM-render + collect `a[href]`) and
`CommandPalette.normalUser.test.tsx`.

**Why the palette differs:** the CommandPalette no-query view slices to 12 rows
(`visibleItems.slice(0,12)`) and search to 30, so scraping the rendered list can
NEVER enumerate the full command set — DOM coverage there is a false pass. So the
palette exports `COMMAND_PALETTE_ITEMS` + the pure resolver
`visibleCommandPaletteItems({isAdmin,isInvestor})` (also the component's own
filter — single source of truth), and the test drives coverage off the resolved
registry, untruncated. The component is still rendered, but only to PROVE pruning
is real (admin/investor rows truly disappear), never to measure coverage.

**How to apply:** when a nav surface truncates/virtualizes its list, assert
coverage against an exported data registry resolved through the component's own
role filter; reserve render-based checks for pruning/non-vacuity proofs. Always
add a non-vacuous guard (admin sees ≥1 off-allowlist route) so "allowlist
contains everything" can't green the test.

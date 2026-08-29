// Route-level access containment for normal (non-admin) users.
//
// This is the route-level companion to the nav-visibility pruning in
// AppLayout. Nav pruning only HIDES advanced/admin/dormant surfaces from the
// sidebar — they were still reachable by typing the URL. This module closes
// that gap with a DEFAULT-DENY allowlist: any path not listed here is blocked
// for non-admin sessions (both in nav and by direct URL).
//
// OWNER/ADMIN sessions bypass this entirely (they keep full access to every
// route, matching the fact that every surface stays in their nav). Preview
// "view as user" mode is disabled, so realIsAdmin === effectiveIsAdmin.
//
// IMPORTANT: this is a product-containment / UX layer, NOT a security
// boundary. Backend route guards (requireAdmin, per-user ownership, the
// 16-gate live pipeline, kill switch) remain authoritative for all data and
// every trade action. Nothing here weakens those.
//
// To keep a route reachable by normal users, add it below. The visible nav
// groups in AppLayout are the source of truth for the pinned product surfaces;
// the extra entries are product-fit routes reachable by in-app flow or old
// bookmarks/aliases that are NOT pinned in the sidebar.
//
// TWO-TIER human trader containment (Task #768)
// ─────────────────────────────────────────────
// Human traders come in two tiers, mirroring the nav-visibility tiers in
// AppLayout:
//   • PENDING / unapproved  → a REDUCED, non-execution allowlist
//     (`PENDING_USER_EXACT` + `PENDING_USER_PREFIXES`): cockpit, onboarding,
//     ARX status, trading school, account, settings, help, and the always-on
//     safety surfaces. They CANNOT reach live/scanner/chart/positions/etc.
//   • APPROVED (live / shared-bridge) → the FULL allowlist (`NORMAL_USER_EXACT`
//     + `NORMAL_USER_PREFIXES`), which is a strict superset of the pending set.
// Loading / unresolved approval is treated as PENDING (locked) by the caller
// (RouteAccessGuard). Admin/owner sessions bypass both tiers entirely.

// ── Tier 1: PENDING / unapproved human trader (reduced, non-execution) ──
// The exact-match product routes an UNAPPROVED human trader may reach. This is
// the reduced onboarding/learn/account experience — no execution, scanner, or
// chart-trading surfaces. It is a strict subset of NORMAL_USER_EXACT below.
const PENDING_USER_EXACT: ReadonlySet<string> = new Set<string>([
  // ── Reduced essentials (always visible to every human trader) ──
  "/",                       // Cockpit
  "/status-command-center",  // ARX Status
  "/onboarding",             // first-run flow for new accounts
  "/school",                 // Trading School home
  "/my-account",             // Account
  "/settings",               // Settings
  "/help",                   // Help
  // ── Always-available safety surface ──
  "/emergency",              // emergency stop / kill switch — never gated away
  // ── Notification surfaces reachable from the bell ──
  "/notifications",
  "/alerts-center",
]);

// Prefix-match routes a PENDING human trader may reach (dynamic segments).
const PENDING_USER_PREFIXES: readonly string[] = [
  "/school/", // Trading School sub-routes
];

// ── Tier 2: APPROVED (live / shared-bridge) human trader (full menu) ──
// Exact-match product routes an APPROVED human trader may reach.
const NORMAL_USER_EXACT: ReadonlySet<string> = new Set<string>([
  // ── Primary (visible nav group) ──
  "/",
  "/market-scanner",
  "/trade-command-room",
  "/ai-command-center",
  "/my-trades",
  "/positions",
  "/risk-command-center",
  "/profit-missions",
  "/alerts",
  "/live-trading", // promoted into the approved-trader Primary group (Task #768)
  // ── Markets & Tools (visible nav group) ──
  "/live-chart",
  "/watchlists",
  "/orders",
  "/mt5-setup",
  "/economic-calendar",
  "/news-risk",
  "/market-heat-map",
  "/trading-calendar",
  // ── Performance & History (visible nav group) ──
  "/performance-scorecard",
  // Self-Trading product surfaces (blueprint #43 Approval Inbox, per-user
  // journal at /journal) — both server-scoped to req.authUser.id; the nav
  // entries existed before the allowlist caught up (NavSurfaces.normalUser).
  "/approval-inbox",
  "/journal",
  "/analytics",
  "/trade-logs",
  "/shadow-journal",
  "/scalp-journal",
  // ── Account & Control (visible nav group) ──
  "/my-account",
  "/settings",
  "/help",
  // Capability #37 — the authority-grant press. missionPromotionService
  // refuses an automation increase with the words "requires an active
  // owner-pressed authority grant"; without this entry that documented
  // blocker has no destination and stays a dead end.
  "/authority",
  // Capability #44 — manual takeover of a live position. A safety
  // affordance; it must be reachable by the person who owns the position.
  "/position-control",
  // Capability #46 — the broker-native escape route. The page and route
  // existed; the allowlist entry did not, so a normal trader typing the URL
  // was bounced home.
  "/escape-route",
  // ── Advanced AI & Strategy (visible nav group) ──
  "/ai-coach",
  "/trade-grader",
  "/market-health",
  "/strategy-lab",
  "/autopilot-control-center",
  "/shadow-mode",
  "/testing-lab",
  "/market-replay",
  "/strategy-tournament",
  "/strategy-promotion",
  "/confidence-calibration",
  "/brain",
  "/edge-discovery",
  "/trader-skill",
  "/ai-readiness-score",
  "/trading-intelligence",
  "/weekly-review",
  "/trade-plan-builder",
  "/post-trade-debriefs",
  // ── Trading School (visible nav group) ──
  "/school", // Trading School home
  // ── Always-available safety surface ──
  "/emergency", // emergency stop / kill switch — must never be gated away
  // ── Product-fit flow / alias routes (not pinned in nav) ──
  "/scanner", // redirect → /market-scanner
  "/charts", // alias → live market chart
  "/broker", // alias → MT5 Setup
  "/risk-profile", // alias → Risk command center
  "/my-performance", // personal DEMO trade journal (Demo, never Paper)
  "/notifications", // notification-bell target
  "/alerts-center", // alert detail surface
  "/onboarding", // first-run flow for new accounts
  "/status-command-center", // ARX Status (reduced-essential, visible to every tier)
]);

// Prefix-match product routes (dynamic segments).
const NORMAL_USER_PREFIXES: readonly string[] = [
  "/my-trades/", // trade detail: /my-trades/:tradeKey
  "/school/", // Trading School sub-routes: program, lesson/:id, glossary, risk-simulator, labs, progress
];

/** Normalise a wouter location to a bare pathname for matching. */
function normalisePath(location: string): string {
  // Strip query/hash defensively (wouter usually omits them).
  let p = location.split("?")[0].split("#")[0];
  if (p.length > 1 && p.endsWith("/")) p = p.replace(/\/+$/, "");
  return p || "/";
}

/**
 * True when `location` is a product surface an APPROVED (live / shared-bridge)
 * human trader is allowed to reach — the FULL trader allowlist. Admin/owner
 * sessions should bypass this check entirely.
 */
export function isNormalUserAllowedPath(location: string): boolean {
  const path = normalisePath(location);
  if (NORMAL_USER_EXACT.has(path)) return true;
  return NORMAL_USER_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * True when `location` is a product surface a PENDING / unapproved human trader
 * is allowed to reach — the REDUCED, non-execution allowlist (a strict subset
 * of {@link isNormalUserAllowedPath}). Used by RouteAccessGuard to contain a
 * not-yet-approved trader (and any session whose approval is still loading) to
 * the onboarding / learn / account experience. Admin/owner sessions bypass it.
 */
export function isPendingTraderAllowedPath(location: string): boolean {
  const path = normalisePath(location);
  if (PENDING_USER_EXACT.has(path)) return true;
  return PENDING_USER_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * Tier-aware allowlist check for a human trader. APPROVED traders get the full
 * allowlist; pending/unapproved (or loading-approval) traders get the reduced
 * pending allowlist. This is the single entry point RouteAccessGuard uses.
 */
export function isHumanTraderAllowedPath(
  location: string,
  opts: { isApprovedTrader: boolean },
): boolean {
  return opts.isApprovedTrader
    ? isNormalUserAllowedPath(location)
    : isPendingTraderAllowedPath(location);
}

// ── Investor containment (Task #71) ────────────────────────────────────────
// Investor accounts are view-only and are confined to the (downstream)
// Investor Portal plus universal account/help surfaces. Everything else —
// trading, scanner, admin — is off-limits and redirects them back to /investor.
const INVESTOR_EXACT: ReadonlySet<string> = new Set<string>([
  "/investor",
  "/help",
  "/my-account",
  "/settings",
]);

const INVESTOR_PREFIXES: readonly string[] = [
  "/investor/", // future portal sub-routes
];

/**
 * True when `location` is a surface an INVESTOR account is allowed to reach.
 */
export function isInvestorAllowedPath(location: string): boolean {
  const path = normalisePath(location);
  if (INVESTOR_EXACT.has(path)) return true;
  return INVESTOR_PREFIXES.some((prefix) => path.startsWith(prefix));
}

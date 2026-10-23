import {
  describe, it, expect, beforeEach, afterEach, vi,
} from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { SidebarContent } from "./AppLayout";
import { MobileBottomNav } from "./MobileBottomNav";
import { FloatingActionPanel } from "@/components/trading/FloatingActionPanel";
import { TooltipProvider } from "@/components/ui/tooltip";
import { isNormalUserAllowedPath, isPendingTraderAllowedPath } from "@/lib/routeAccess";

/**
 * Dead-end nav guard (Task #466).
 *
 * The Trading School tab silently bounced normal (non-admin) users back to the
 * cockpit because its routes were missing from the normal-user route-containment
 * allowlist (`isNormalUserAllowedPath`), even though the page, route, and nav
 * entry all existed and looked correct. RouteAccessGuard redirects any
 * non-allowlisted, non-/admin path home — so a normal-user-visible nav target
 * that is NOT on the allowlist becomes a silent dead end with no compile-time
 * or test failure.
 *
 * This test renders the visible nav surfaces a normal trader sees — the desktop
 * sidebar/menu, the mobile bottom nav, and the floating quick-action panel
 * (each gates role visibility INDEPENDENTLY, see
 * .agents/memory/nav-role-surfaces.md) — collects every product link they
 * expose to that trader, and asserts each one resolves to a path allowed by
 * `isNormalUserAllowedPath`. If a new normal-user-visible nav item is added
 * without an allowlist entry (exact or prefix), this fails the build.
 *
 * Admin-only / investor-only nav entries are excluded by construction: the
 * surfaces are rendered as a NON-admin, NON-investor session, so the components'
 * own role gating prunes those items before we collect anything. A separate
 * "rendered as admin" assertion proves that pruning is real — an admin sees at
 * least one route that is NOT on the normal-user allowlist — so the normal-user
 * assertion can never pass vacuously by the allowlist simply containing
 * everything.
 *
 * This is a product-containment / UX guard, NOT a security boundary. Backend
 * route guards remain authoritative for data and every trade action.
 */

const h = vi.hoisted(() => ({
  location: "/" as string,
  setLocation: vi.fn(),
  effectiveIsAdmin: false,
  isInvestor: false,
  isApprovedTrader: true,
}));

vi.mock("wouter", () => ({
  useLocation: () => [h.location, h.setLocation] as const,
  // Forward href so collected anchors carry their route target into the DOM.
  Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string; [k: string]: unknown }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));
vi.mock("@/hooks/useViewMode", () => ({
  useViewMode: () => ({ effectiveIsAdmin: h.effectiveIsAdmin }),
}));
vi.mock("@/hooks/useProductRole", () => ({
  useProductRole: () => ({ isInvestor: h.isInvestor }),
}));
vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ user: null, isLoading: false }),
}));
// Two-tier human-trader gate (Task #768) — APPROVED traders see the full
// execution menu; PENDING/loading traders see the reduced non-execution menu.
vi.mock("@/hooks/useTraderTier", () => ({
  useTraderTier: () => ({ isLoading: false, isApprovedTrader: h.isApprovedTrader }),
}));

// FloatingActionPanel pulls bot-status hooks + toast + unlocks at the top of the
// component, so they must be mocked for it to render.
vi.mock("@workspace/api-client-react", () => ({
  useGetBotStatus: () => ({ data: undefined }),
  useUpdateBotStatus: () => ({ mutate: vi.fn() }),
  getGetBotStatusQueryKey: () => ["bot-status"],
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));
vi.mock("@/hooks/useFeatureUnlock", () => ({
  useAllUnlocks: () => ({ mt5: false, simulator: false }),
}));

function asTrader() {
  h.effectiveIsAdmin = false;
  h.isInvestor = false;
  h.isApprovedTrader = true;
}
function asPendingTrader() {
  h.effectiveIsAdmin = false;
  h.isInvestor = false;
  h.isApprovedTrader = false;
}
function asAdmin() {
  h.effectiveIsAdmin = true;
  h.isInvestor = false;
}

/** Collect every absolute (`/…`) link target from a rendered container. */
function collectRoutes(container: HTMLElement): string[] {
  const anchors = Array.from(container.querySelectorAll("a[href]"));
  const hrefs = anchors
    .map((a) => a.getAttribute("href") ?? "")
    .filter((href) => href.startsWith("/"));
  return Array.from(new Set(hrefs));
}

/** Routes the desktop sidebar/menu exposes to the current session. */
function sidebarRoutes(): string[] {
  // collapsed=true forces every nav group's items to render (default-collapsed
  // groups otherwise hide their items), so we see the full menu a user can open.
  const { container } = render(
    <TooltipProvider>
      <SidebarContent collapsed />
    </TooltipProvider>,
  );
  return collectRoutes(container);
}

/** Routes the mobile bottom nav exposes to the current session. */
function mobileRoutes(): string[] {
  const { container } = render(<MobileBottomNav />);
  return collectRoutes(container);
}

/** Routes the floating quick-action panel exposes once opened. */
function fabRoutes(): string[] {
  const { container } = render(<FloatingActionPanel />);
  fireEvent.click(screen.getByTestId("fab-toggle"));
  return collectRoutes(container);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.location = "/";
  h.setLocation = vi.fn();
  asTrader();
});
afterEach(() => {
  cleanup();
});

describe("normal-user nav surfaces only link to allowlisted routes", () => {
  it("every desktop sidebar/menu link is reachable by a normal user", () => {
    asTrader();
    const routes = sidebarRoutes();
    // Sanity: the menu actually rendered a meaningful set (guards a vacuous pass
    // if the render silently produced nothing).
    expect(routes.length).toBeGreaterThan(10);
    expect(routes).toContain("/"); // Cockpit
    expect(routes).toContain("/market-scanner");
    expect(routes).toContain("/school"); // the Trading School regression
    expect(routes).toContain("/emergency");

    const deadEnds = routes.filter((r) => !isNormalUserAllowedPath(r));
    expect(
      deadEnds,
      `sidebar links not on the normal-user allowlist (add to routeAccess.ts): ${deadEnds.join(", ")}`,
    ).toEqual([]);
  });

  it("every mobile bottom-nav link is reachable by a normal user", () => {
    asTrader();
    const routes = mobileRoutes();
    expect(routes.length).toBeGreaterThan(3);
    expect(routes).toContain("/"); // Cockpit
    expect(routes).toContain("/my-account"); // the "Me" tail (non-admin)
    // The admin-only "More" tail must NOT be present for a trader.
    expect(routes).not.toContain("/admin/data-management");

    const deadEnds = routes.filter((r) => !isNormalUserAllowedPath(r));
    expect(
      deadEnds,
      `mobile bottom-nav links not on the normal-user allowlist: ${deadEnds.join(", ")}`,
    ).toEqual([]);
  });

  it("every floating quick-action link is reachable by a normal user", () => {
    asTrader();
    const routes = fabRoutes();
    expect(routes.length).toBeGreaterThan(3);
    expect(routes).toContain("/trade-command-room");
    expect(routes).toContain("/emergency");
    // Admin-only quick actions must NOT be present for a trader.
    expect(routes).not.toContain("/self-trade-ai");

    const deadEnds = routes.filter((r) => !isNormalUserAllowedPath(r));
    expect(
      deadEnds,
      `floating quick-action links not on the normal-user allowlist: ${deadEnds.join(", ")}`,
    ).toEqual([]);
  });

  it("the combined normal-user nav target set is fully allowlisted", () => {
    asTrader();
    const all = Array.from(
      new Set([...sidebarRoutes(), ...mobileRoutes(), ...fabRoutes()]),
    );
    const deadEnds = all.filter((r) => !isNormalUserAllowedPath(r));
    expect(
      deadEnds,
      `normal-user-visible nav targets missing from isNormalUserAllowedPath: ${deadEnds.join(", ")}`,
    ).toEqual([]);
  });
});

describe("pending (unapproved) human trader sees the reduced non-execution menu", () => {
  it("the desktop sidebar drops execution surfaces and stays inside the pending allowlist", () => {
    asPendingTrader();
    const routes = sidebarRoutes();
    // Reduced essentials + account/help + emergency are present…
    expect(routes).toContain("/"); // Cockpit
    expect(routes).toContain("/school"); // Trading School (learn)
    expect(routes).toContain("/my-account"); // Account
    expect(routes).toContain("/emergency"); // always-on safety surface
    // …but NO approved-only execution / scanner / chart surfaces.
    expect(routes).not.toContain("/market-scanner");
    expect(routes).not.toContain("/trade-command-room");
    expect(routes).not.toContain("/live-trading");
    expect(routes).not.toContain("/positions");
    // Every surface a pending trader can reach is on the reduced allowlist.
    const deadEnds = routes.filter((r) => !isPendingTraderAllowedPath(r));
    expect(
      deadEnds,
      `pending sidebar links not on the reduced allowlist: ${deadEnds.join(", ")}`,
    ).toEqual([]);
  });

  it("the mobile bottom nav shows only the reduced non-execution anchors", () => {
    asPendingTrader();
    const routes = mobileRoutes();
    expect(routes).toContain("/"); // Cockpit
    expect(routes).toContain("/school"); // Learn
    expect(routes).toContain("/my-account"); // Me
    expect(routes).not.toContain("/trade-command-room");
    expect(routes).not.toContain("/market-scanner");
    expect(routes).not.toContain("/ai-command-center");
    const deadEnds = routes.filter((r) => !isPendingTraderAllowedPath(r));
    expect(deadEnds).toEqual([]);
  });

  it("the floating quick-action panel exposes only the always-on Emergency action", () => {
    asPendingTrader();
    const routes = fabRoutes();
    // Trade / scanner / AI / risk quick actions are gated behind approval; only
    // the Emergency Kill Switch (always rendered) remains.
    expect(routes).toContain("/emergency");
    expect(routes).not.toContain("/trade-command-room");
    expect(routes).not.toContain("/market-scanner");
    const deadEnds = routes.filter((r) => !isPendingTraderAllowedPath(r));
    expect(deadEnds).toEqual([]);
  });
});

describe("the normal-user filtering is real (non-vacuous guard)", () => {
  it("an admin sees sidebar routes that are NOT on the normal-user allowlist", () => {
    // If rendering as admin exposed only allowlisted routes, the normal-user
    // assertion above could pass simply because the allowlist contains every
    // route. Proving an admin sees off-allowlist routes confirms the non-admin
    // render genuinely pruned admin-only items.
    asAdmin();
    const routes = sidebarRoutes();
    const offAllowlist = routes.filter((r) => !isNormalUserAllowedPath(r));
    expect(offAllowlist.length).toBeGreaterThan(0);
  });
});

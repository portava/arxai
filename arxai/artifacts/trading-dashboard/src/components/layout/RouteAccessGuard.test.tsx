import {
  describe, it, expect, beforeEach, afterEach, vi,
} from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { RouteAccessGuard } from "./RouteAccessGuard";

/**
 * Trader containment coverage (verification for "Verify regular traders also
 * can't reach admin or investor screens").
 *
 * RouteAccessGuard is the client-side containment that wraps every page in
 * AppLayout. This test renders it directly as a NORMAL TRADER (not admin, not
 * investor) and asserts the three behaviours a browser walkthrough sees:
 *
 *   1. An allowlisted product path (cockpit "/", "/market-scanner") renders the
 *      page content — the trader keeps their own cockpit.
 *   2. A direct /admin/* URL renders the non-admin containment LOCK CARD
 *      (data-testid="viewmode-nonadmin-blocked" + "Go to Cockpit") and the
 *      wrapped admin page content NEVER renders.
 *   3. A non-allowlisted, non-/admin URL (e.g. /investor) redirects the trader
 *      home to "/" and never renders the wrapped content.
 *
 * The pure allowlist logic (isNormalUserAllowedPath / isInvestorAllowedPath) is
 * also asserted in admin-hub.routes.test.ts; this file guards the RENDERED
 * containment states the guard produces from that logic. Backend route guards
 * (requireAdmin, per-user ownership, the 16-gate live pipeline) remain
 * authoritative for data regardless of what the frontend renders.
 */

const h = vi.hoisted(() => ({
  location: "/" as string,
  setLocation: vi.fn(),
  viewMode: {
    realIsAdmin: false,
    effectiveIsAdmin: false,
    canToggle: false,
    setViewMode: vi.fn(),
  },
  currentUser: { isLoading: false },
  productRole: { isInvestor: false },
  traderTier: { isLoading: false, isApprovedTrader: true },
}));

vi.mock("wouter", () => ({
  useLocation: () => [h.location, h.setLocation] as const,
}));
vi.mock("@/hooks/useViewMode", () => ({
  useViewMode: () => h.viewMode,
}));
vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => h.currentUser,
}));
vi.mock("@/hooks/useProductRole", () => ({
  useProductRole: () => h.productRole,
}));
vi.mock("@/hooks/useTraderTier", () => ({
  useTraderTier: () => h.traderTier,
}));

const PAGE_TESTID = "guarded-page-content";

function renderAsTrader(
  location: string,
  tier: { isLoading: boolean; isApprovedTrader: boolean } = { isLoading: false, isApprovedTrader: true },
) {
  h.location = location;
  h.setLocation = vi.fn();
  h.viewMode = {
    realIsAdmin: false,
    effectiveIsAdmin: false,
    canToggle: false,
    setViewMode: vi.fn(),
  };
  h.currentUser = { isLoading: false };
  h.productRole = { isInvestor: false };
  h.traderTier = tier;
  return render(
    <RouteAccessGuard>
      <div data-testid={PAGE_TESTID}>PROTECTED PAGE CONTENT</div>
    </RouteAccessGuard>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
});

describe("RouteAccessGuard — normal trader containment", () => {
  it("renders the cockpit page for an allowlisted product path", () => {
    renderAsTrader("/");
    expect(screen.getByTestId(PAGE_TESTID)).toBeTruthy();
    expect(screen.queryByTestId("viewmode-nonadmin-blocked")).toBeNull();
    expect(h.setLocation).not.toHaveBeenCalled();
  });

  it("renders another allowlisted product path (market scanner)", () => {
    renderAsTrader("/market-scanner");
    expect(screen.getByTestId(PAGE_TESTID)).toBeTruthy();
    expect(h.setLocation).not.toHaveBeenCalled();
  });
});

describe("RouteAccessGuard — two-tier human-trader containment (Task #768)", () => {
  it("lets a PENDING trader keep a reduced-tier path (trading school) without waiting on approval", () => {
    renderAsTrader("/school", { isLoading: false, isApprovedTrader: false });
    expect(screen.getByTestId(PAGE_TESTID)).toBeTruthy();
    expect(h.setLocation).not.toHaveBeenCalled();
  });

  it("keeps the cockpit reachable for a PENDING trader", () => {
    renderAsTrader("/", { isLoading: false, isApprovedTrader: false });
    expect(screen.getByTestId(PAGE_TESTID)).toBeTruthy();
    expect(h.setLocation).not.toHaveBeenCalled();
  });

  it("redirects a PENDING trader home from an approved-only execution surface", async () => {
    renderAsTrader("/market-scanner", { isLoading: false, isApprovedTrader: false });
    expect(screen.getByTestId("routeaccess-nonproduct-redirect")).toBeTruthy();
    expect(screen.queryByTestId(PAGE_TESTID)).toBeNull();
    await waitFor(() => expect(h.setLocation).toHaveBeenCalledWith("/"));
  });

  it("redirects a PENDING trader home from live trading", async () => {
    renderAsTrader("/live-trading", { isLoading: false, isApprovedTrader: false });
    expect(screen.queryByTestId(PAGE_TESTID)).toBeNull();
    await waitFor(() => expect(h.setLocation).toHaveBeenCalledWith("/"));
  });

  it("holds on the approval-loading skeleton for an approved-only path while the tier resolves", () => {
    renderAsTrader("/market-scanner", { isLoading: true, isApprovedTrader: false });
    // Neither the page nor a redirect happens — we wait on a neutral skeleton so
    // an approved trader is not bounced off a deep-linked execution URL.
    expect(screen.getByTestId("routeaccess-approval-loading")).toBeTruthy();
    expect(screen.queryByTestId(PAGE_TESTID)).toBeNull();
    expect(h.setLocation).not.toHaveBeenCalled();
  });

  it("does NOT block a reduced-tier path on the approval signal even while it is loading", () => {
    // The pending allowlist is reachable by every human trader, so the cockpit
    // renders immediately without waiting on the approval query.
    renderAsTrader("/", { isLoading: true, isApprovedTrader: false });
    expect(screen.getByTestId(PAGE_TESTID)).toBeTruthy();
    expect(screen.queryByTestId("routeaccess-approval-loading")).toBeNull();
    expect(h.setLocation).not.toHaveBeenCalled();
  });

  it("renders an approved-only execution surface for an APPROVED trader", () => {
    renderAsTrader("/live-trading", { isLoading: false, isApprovedTrader: true });
    expect(screen.getByTestId(PAGE_TESTID)).toBeTruthy();
    expect(h.setLocation).not.toHaveBeenCalled();
  });
});

describe("RouteAccessGuard — admin / investor containment", () => {
  it("shows the non-admin lock card on /admin/users and never the admin page", () => {
    renderAsTrader("/admin/users");
    expect(screen.getByTestId("viewmode-nonadmin-blocked")).toBeTruthy();
    expect(
      screen.getByText("This area is not available on your account"),
    ).toBeTruthy();
    expect(screen.getByTestId("button-nonadmin-go-home")).toBeTruthy();
    // The wrapped admin page content must NOT render.
    expect(screen.queryByTestId(PAGE_TESTID)).toBeNull();
    // Lock card is a contained state, not a redirect.
    expect(h.setLocation).not.toHaveBeenCalled();
  });

  it("shows the non-admin lock card on the operator command center", () => {
    renderAsTrader("/admin/operator-command-center");
    expect(screen.getByTestId("viewmode-nonadmin-blocked")).toBeTruthy();
    expect(screen.queryByTestId(PAGE_TESTID)).toBeNull();
  });

  it("shows the non-admin lock card on the admin investors screen", () => {
    renderAsTrader("/admin/investors");
    expect(screen.getByTestId("viewmode-nonadmin-blocked")).toBeTruthy();
    expect(screen.queryByTestId(PAGE_TESTID)).toBeNull();
  });

  it("redirects a trader home from the investor portal and hides its content", async () => {
    renderAsTrader("/investor");
    // Redirect skeleton renders immediately; the wrapped content never does.
    expect(screen.getByTestId("routeaccess-nonproduct-redirect")).toBeTruthy();
    expect(screen.queryByTestId(PAGE_TESTID)).toBeNull();
    await waitFor(() => expect(h.setLocation).toHaveBeenCalledWith("/"));
  });

  it("never offers the admin-mode toggle card to a real non-admin", () => {
    renderAsTrader("/admin/users");
    // The "previewing as user" card (for real admins) must not appear.
    expect(screen.queryByTestId("viewmode-admin-blocked")).toBeNull();
    expect(screen.queryByTestId("button-viewmode-return-admin")).toBeNull();
  });
});

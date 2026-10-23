import {
  describe, it, expect, beforeEach, afterEach, vi,
} from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { MobileBottomNav } from "./MobileBottomNav";
import { CommandPalette } from "./CommandPalette";
import { FloatingActionPanel } from "@/components/trading/FloatingActionPanel";

/**
 * Investor containment across ALL global nav surfaces (verification for
 * "Confirm investors stay contained on mobile and quick-access menus too").
 *
 * ARX AI mounts four global nav surfaces in AppLayout for every authenticated
 * session, and each gates role visibility INDEPENDENTLY (see
 * .agents/memory/nav-role-surfaces.md). The desktop sidebar containment is
 * already covered by RouteAccessGuard.test.tsx; this file locks the other three
 * surfaces that a mobile / quick-access user reaches:
 *
 *   1. MobileBottomNav  — an INVESTOR sees ONLY Portal/Account/Settings/Help,
 *      never Cockpit/Trade/Scanner/AI or the admin "More" tail.
 *   2. FloatingActionPanel ("+") — renders nothing for an INVESTOR (no FAB).
 *   3. CommandPalette (Ctrl/Cmd+K) — renders nothing for an INVESTOR (no
 *      trigger, no dialog).
 *
 * Each surface is also asserted in its NON-investor (normal trader) state so a
 * "component always returns null" regression cannot make this test pass
 * vacuously. Backend route guards + the per-method investor execution-deny gate
 * remain authoritative for data and trades regardless of what renders here.
 */

const h = vi.hoisted(() => ({
  location: "/investor" as string,
  setLocation: vi.fn(),
  isInvestor: true,
  effectiveIsAdmin: false,
  isApprovedTrader: true,
}));

vi.mock("wouter", () => ({
  useLocation: () => [h.location, h.setLocation] as const,
  // Forward data-* / aria props so testids on <Link> survive into the DOM.
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
// Two-tier human-trader gate (Task #768). Investor containment is independent of
// approval tier; the trader-state assertions use an APPROVED trader (full menu).
vi.mock("@/hooks/useTraderTier", () => ({
  useTraderTier: () => ({ isLoading: false, isApprovedTrader: h.isApprovedTrader }),
}));

// FloatingActionPanel pulls bot-status hooks + toast + unlocks at the top of the
// component (before its investor null-return), so they must be mocked even
// though an investor never reaches the rendering that uses them.
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

function asInvestor() {
  h.isInvestor = true;
  h.effectiveIsAdmin = false;
}
function asTrader() {
  h.isInvestor = false;
  h.effectiveIsAdmin = false;
  h.isApprovedTrader = true;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.location = "/investor";
  h.setLocation = vi.fn();
});
afterEach(() => {
  cleanup();
});

describe("MobileBottomNav — investor containment", () => {
  it("shows only Portal/Account/Settings/Help for an investor", () => {
    asInvestor();
    render(<MobileBottomNav />);
    expect(screen.getByTestId("bottomnav--investor")).toBeTruthy();
    expect(screen.getByTestId("bottomnav--my-account")).toBeTruthy();
    expect(screen.getByTestId("bottomnav--settings")).toBeTruthy();
    expect(screen.getByTestId("bottomnav--help")).toBeTruthy();
  });

  it("never exposes trading/admin anchors to an investor", () => {
    asInvestor();
    render(<MobileBottomNav />);
    expect(screen.queryByTestId("bottomnav--")).toBeNull(); // Cockpit ("/")
    expect(screen.queryByTestId("bottomnav--trade-command-room")).toBeNull();
    expect(screen.queryByTestId("bottomnav--market-scanner")).toBeNull();
    expect(screen.queryByTestId("bottomnav--ai-command-center")).toBeNull();
    expect(screen.queryByTestId("bottomnav--admin-data-management")).toBeNull();
  });

  it("DOES expose Trade/Scanner/AI to a normal trader (guards against vacuous pass)", () => {
    asTrader();
    render(<MobileBottomNav />);
    expect(screen.getByTestId("bottomnav--")).toBeTruthy(); // Cockpit ("/")
    expect(screen.getByTestId("bottomnav--trade-command-room")).toBeTruthy();
    expect(screen.getByTestId("bottomnav--market-scanner")).toBeTruthy();
    expect(screen.getByTestId("bottomnav--ai-command-center")).toBeTruthy();
    // Investor-only Portal anchor must NOT appear for a trader.
    expect(screen.queryByTestId("bottomnav--investor")).toBeNull();
  });
});

describe("FloatingActionPanel — investor containment", () => {
  it("renders no quick-action FAB for an investor", () => {
    asInvestor();
    const { container } = render(<FloatingActionPanel />);
    expect(screen.queryByTestId("fab-toggle")).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  it("renders the FAB for a normal trader (guards against vacuous pass)", () => {
    asTrader();
    render(<FloatingActionPanel />);
    expect(screen.getByTestId("fab-toggle")).toBeTruthy();
  });
});

describe("CommandPalette — investor containment", () => {
  it("renders nothing (no trigger) for an investor", () => {
    asInvestor();
    const { container } = render(<CommandPalette />);
    expect(screen.queryByTestId("cmdk-trigger")).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  it("ignores the Ctrl/Cmd+K hotkey for an investor", () => {
    asInvestor();
    render(<CommandPalette />);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(screen.queryByTestId("cmdk-dialog")).toBeNull();
    expect(screen.queryByTestId("cmdk-input")).toBeNull();
  });

  it("renders the launcher trigger for a normal trader (guards against vacuous pass)", () => {
    asTrader();
    render(<CommandPalette />);
    expect(screen.getByTestId("cmdk-trigger")).toBeTruthy();
  });
});

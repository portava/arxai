import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { SidebarContent } from "@/components/layout/AppLayout";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * Nav consolidation guard (Backtesting + Forward Testing → Testing Lab).
 *
 * The two separate admin nav items were merged into ONE "Testing Lab" entry.
 * This renders the admin sidebar and asserts exactly one /testing-lab link and
 * zero /backtesting or /forward-testing links — so a future re-introduction of
 * the split items fails the build.
 */

const h = vi.hoisted(() => ({
  location: "/" as string,
  setLocation: vi.fn(),
  effectiveIsAdmin: true,
  isInvestor: false,
}));

vi.mock("wouter", () => ({
  useLocation: () => [h.location, h.setLocation] as const,
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
// Two-tier human-trader gate (Task #768). This suite renders as admin, which
// bypasses tier gating, so the approval value is immaterial here.
vi.mock("@/hooks/useTraderTier", () => ({
  useTraderTier: () => ({ isLoading: false, isApprovedTrader: true }),
}));

afterEach(() => cleanup());
beforeEach(() => {
  vi.clearAllMocks();
  h.location = "/";
  h.effectiveIsAdmin = true;
  h.isInvestor = false;
});

/** Collect every `/…` link target (with duplicates) from a container. */
function rawRoutes(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("a[href]"))
    .map((a) => a.getAttribute("href") ?? "")
    .filter((href) => href.startsWith("/"));
}

function adminSidebarRoutes(): string[] {
  const { container } = render(
    <TooltipProvider>
      <SidebarContent collapsed />
    </TooltipProvider>,
  );
  return rawRoutes(container);
}

describe("Testing Lab nav consolidation", () => {
  it("exposes exactly one Testing Lab sidebar item to admins", () => {
    const routes = adminSidebarRoutes();
    expect(routes.filter((r) => r === "/testing-lab")).toHaveLength(1);
  });

  it("no longer exposes the separate Backtesting / Forward Testing items", () => {
    const routes = adminSidebarRoutes();
    expect(routes).not.toContain("/backtesting");
    expect(routes).not.toContain("/forward-testing");
  });
});

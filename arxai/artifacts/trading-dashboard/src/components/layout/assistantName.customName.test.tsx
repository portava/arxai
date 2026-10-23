import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

/**
 * Custom assistant-name render proof (Task #644).
 *
 * Task #640 made the assistant display name per-user customizable (default
 * "Eleanor", resolved via `useAssistantName()`). The desktop sidebar nav and
 * the Ctrl/Cmd+K command palette both build their user-facing copy from that
 * resolved name. These render proofs lock that wiring: with a NON-default name
 * supplied ("Nova"), the custom name must appear in the rendered labels/hints
 * and the default ("Eleanor") must NOT. A regression that re-pins either
 * surface to the static default fails here.
 *
 * Per the codebase's render-proof convention we mock data hooks (no
 * QueryClientProvider / network) and stub the heavy AppLayout siblings that
 * SidebarContent does not itself render, so importing the layout module stays
 * cheap and deterministic. The REAL ARX brand mark, ui primitives, and the
 * CommandPalette component load unmocked.
 */

// One source of the resolved name for the whole app — force a custom value.
vi.mock("@/lib/assistant-name", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/assistant-name")>();
  return {
    ...actual,
    useAssistantName: () => ({ name: "Nova", isLoading: false, isDefault: false }),
  };
});

// wouter Link/useLocation without a Router (we only assert rendered text).
vi.mock("wouter", () => ({
  Link: ({ href, children, ...rest }: { href?: string; children?: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
  useLocation: () => ["/", vi.fn()] as const,
}));

// Session/role hooks — a plain non-admin, non-investor trader. APPROVED so the
// approvedOnly assistant nav item + Scalp Journal hint render (Task #768).
vi.mock("@/hooks/useViewMode", () => ({ useViewMode: () => ({ effectiveIsAdmin: false }) }));
vi.mock("@/hooks/useProductRole", () => ({ useProductRole: () => ({ isInvestor: false }) }));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: null }) }));
vi.mock("@/hooks/useTraderTier", () => ({ useTraderTier: () => ({ isLoading: false, isApprovedTrader: true }) }));

// Imported AFTER the mocks (vi.mock is hoisted) so they bind the stubs.
import { SidebarContent } from "./AppLayout";
import { CommandPalette } from "./CommandPalette";

afterEach(() => cleanup());

describe("sidebar nav renders the user's custom assistant name", () => {
  it("shows the custom name (not the default) in the nav label", () => {
    render(<SidebarContent />);
    // The assistant nav item label is `${name} (AI)`.
    expect(screen.getByText("Nova (AI)")).toBeTruthy();
    // The default name must not leak anywhere in the rendered nav.
    expect(screen.queryByText(/Eleanor/)).toBeNull();
  });
});

describe("command palette renders the user's custom assistant name", () => {
  it("shows the custom name (not the default) in the Scalp Journal hint", () => {
    render(<CommandPalette />);
    // Palette starts closed → open it, then search to surface the hint row.
    fireEvent.click(screen.getByTestId("cmdk-trigger"));
    fireEvent.change(screen.getByTestId("cmdk-input"), { target: { value: "scalp" } });

    expect(screen.getByText("Nova scalp history & lessons")).toBeTruthy();
    expect(screen.queryByText("Eleanor scalp history & lessons")).toBeNull();
  });
});

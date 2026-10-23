import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ApprovalPathCard } from "./ApprovalPathCard";

// Task #771 render-proof. The card is self-gating: it must stay hidden for
// approved traders + managing admins, and for a pending trader it must surface
// the honest status + the operator-granted path (never a self-serve unlock).

const h = vi.hoisted(() => ({
  isLoading: false,
  isError: false,
  isLiveShared: false,
  isAdmin: false,
  isAdminPreviewingUserMode: false,
  cleanUserMessage: "" as string,
  cleanBlockedReason: null as string | null,
  envelope: null as null | {
    userApprovalStatus: string;
    accountShellStatus: { tradingMode: string; tradingStatus: string };
  },
  isApprovedTrader: false,
}));

vi.mock("wouter", () => ({
  Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string; [k: string]: unknown }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

vi.mock("@/hooks/useTradingMode", () => ({
  useTradingMode: () => ({
    isLoading: h.isLoading,
    isError: h.isError,
    isLiveShared: h.isLiveShared,
    isAdmin: h.isAdmin,
    isAdminPreviewingUserMode: h.isAdminPreviewingUserMode,
    cleanUserMessage: h.cleanUserMessage,
    cleanBlockedReason: h.cleanBlockedReason,
    envelope: h.envelope,
  }),
}));

vi.mock("@/hooks/useTraderTier", () => ({
  useTraderTier: () => ({ isLoading: h.isLoading, isApprovedTrader: h.isApprovedTrader }),
}));

function pendingTrader() {
  h.isLoading = false;
  h.isError = false;
  h.isLiveShared = false;
  h.isAdmin = false;
  h.isAdminPreviewingUserMode = false;
  h.isApprovedTrader = false;
  h.cleanUserMessage = "Demo mode — practice only.";
  h.cleanBlockedReason = null;
  h.envelope = {
    userApprovalStatus: "NOT_APPROVED",
    accountShellStatus: { tradingMode: "LIVE", tradingStatus: "WAITING_APPROVAL" },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  pendingTrader();
});
afterEach(() => cleanup());

describe("ApprovalPathCard", () => {
  it("renders an honest status + path for a pending trader", () => {
    render(<ApprovalPathCard />);
    expect(screen.getByTestId("cockpit-approval-path")).toBeTruthy();
    expect(screen.getByTestId("approval-status-label").textContent).toContain("Waiting for approval");
    // server-authored detail shown verbatim
    expect(screen.getByTestId("approval-detail").textContent).toContain("Demo mode");
    // guidance is operator-granted, not self-serve
    const guidance = screen.getByTestId("approval-guidance").textContent ?? "";
    expect(guidance.toLowerCase()).toContain("operator");
    expect(guidance.toLowerCase()).toContain("no self-serve");
    // three-step progression rendered
    expect(screen.getByTestId("approval-step-enabled")).toBeTruthy();
    expect(screen.getByTestId("approval-step-approved")).toBeTruthy();
    expect(screen.getByTestId("approval-step-activated")).toBeTruthy();
    // the "approved" step is NOT yet done for a pending trader
    expect(screen.getByTestId("approval-step-approved").getAttribute("data-done")).toBe("false");
    // learn link points at an allowlisted pending route
    expect(screen.getByTestId("approval-learn-link").getAttribute("href")).toBe("/onboarding");
  });

  it("renders nothing for an approved trader (full menu is theirs)", () => {
    h.isApprovedTrader = true;
    const { container } = render(<ApprovalPathCard />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing while the envelope is still loading", () => {
    h.isLoading = true;
    const { container } = render(<ApprovalPathCard />);
    expect(container.firstChild).toBeNull();
  });

  it("fails closed (renders nothing) when the account-mode query errored", () => {
    h.isError = true;
    const { container } = render(<ApprovalPathCard />);
    expect(container.firstChild).toBeNull();
  });

  it("fails closed (renders nothing) when there is no envelope — never synthesizes a stage", () => {
    h.isError = false;
    h.envelope = null;
    const { container } = render(<ApprovalPathCard />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing for a managing admin (not previewing a user)", () => {
    h.isAdmin = true;
    h.isAdminPreviewingUserMode = false;
    const { container } = render(<ApprovalPathCard />);
    expect(container.firstChild).toBeNull();
  });

  it("DOES render for an admin previewing a pending user", () => {
    h.isAdmin = true;
    h.isAdminPreviewingUserMode = true;
    render(<ApprovalPathCard />);
    expect(screen.getByTestId("cockpit-approval-path")).toBeTruthy();
  });
});

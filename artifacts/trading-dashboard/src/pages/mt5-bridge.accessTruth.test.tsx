// Regression: the MT5 Bridge page derived "Execution: Available", "Live
// Access: Enabled", "Access: Approved", "Market Data: Connected", Bridge
// Health "Order Routing / Result Reporting / Position Refresh / Account
// Refresh" and the assistant read "route is healthy … your account is
// approved" from isLiveShared and a fresh heartbeat alone. The account-mode
// blocked reason and liveExecutionArmed were ignored, and none of routing,
// result reporting or refresh is probed by /mt5/status.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

let mode: Record<string, unknown> = {};
vi.mock("@workspace/api-client-react", () => ({
  useGetMt5Status: () => ({ data: { connected: true, secondsSinceHeartbeat: 3 }, isLoading: false }),
  useGetMeSharedAccountSummary: () => ({ data: null }),
  getGetMt5StatusQueryKey: () => ["mt5-status"],
  getGetMeSharedAccountSummaryQueryKey: () => ["summary"],
}));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: () => {} }) }));
vi.mock("@/hooks/useTradingMode", () => ({ useTradingMode: () => mode }));
vi.mock("@/lib/assistant-name", () => ({ useAssistantName: () => ({ name: "Ruby" }) }));

const { default: MT5BridgePage } = await import("./mt5-bridge");

function tile(label: string): string {
  // StatusTile / Row render the label and the value as siblings.
  const els = screen.getAllByText(label, { exact: true });
  return els.map((e) => e.parentElement?.textContent ?? "").join(" | ");
}

afterEach(() => cleanup());

describe("mt5-bridge access truth", () => {
  it("a LIVE_SHARED user who is blocked and not armed is not told execution is available or the account is approved", () => {
    mode = {
      isLoading: false, isFrozen: false, isLiveShared: true, isLiveArmed: false, liveExecutionArmed: false,
      cleanBlockedReason: "KYC_PENDING", cleanModeLabel: "Live Shared",
      envelope: { userApprovalStatus: "NOT_APPROVED", liveExecutionArmed: false },
    };
    const { container } = render(<MT5BridgePage />);
    const text = container.textContent ?? "";
    expect(tile("Execution")).not.toMatch(/Available/);
    expect(tile("Live Access")).not.toMatch(/Enabled/);
    expect(tile("Access")).not.toMatch(/Approved/);
    expect(text).not.toMatch(/account is approved/i);
    expect(text).not.toMatch(/route is healthy/i);
    expect(tile("Order Routing")).not.toMatch(/Available/);
    expect(tile("Result Reporting")).not.toMatch(/Active/);
    expect(tile("Market Data")).not.toMatch(/Connected/);
  });

  it("an armed, approved, unblocked user with a fresh heartbeat sees execution available", () => {
    mode = {
      isLoading: false, isFrozen: false, isLiveShared: true, isLiveArmed: true, liveExecutionArmed: true,
      cleanBlockedReason: null, cleanModeLabel: "Live Shared",
      envelope: { userApprovalStatus: "APPROVED", liveExecutionArmed: true },
    };
    render(<MT5BridgePage />);
    expect(tile("Execution")).toMatch(/Available/);
    expect(tile("Live Access")).toMatch(/Enabled/);
    expect(tile("Access")).toMatch(/Approved/);
  });
});

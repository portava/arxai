// MT5 Bridge page: a settled "not connected" is never shown as "Checking", and
// a shared-master user (no MT5 connection of their own) sees the shared
// master bridge the server reports instead of "shared bridge not connected".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

let statusResult: { data: unknown; isLoading: boolean; isError: boolean };
let tradingMode: Record<string, unknown>;

vi.mock("@workspace/api-client-react", () => ({
  useGetMt5Status: () => statusResult,
  useGetMeSharedAccountSummary: () => ({ data: null, isLoading: false }),
  getGetMt5StatusQueryKey: () => ["mt5-status"],
  getGetMeSharedAccountSummaryQueryKey: () => ["shared-summary"],
}));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock("@/hooks/useTradingMode", () => ({ useTradingMode: () => tradingMode }));
vi.mock("@/lib/assistant-name", () => ({ useAssistantName: () => ({ name: "Ruby" }) }));

const { default: MT5BridgePage } = await import("./mt5-bridge");

const BASE_STATUS = {
  connected: false, mode: "NOT_CONNECTED", lastHeartbeatAt: null, secondsSinceHeartbeat: null,
  accountType: "NONE", openPositions: [], accountSnapshot: null,
};

beforeEach(() => {
  tradingMode = { isLoading: false, isFrozen: false, isLiveShared: true, approvalStatus: "APPROVED" };
});
afterEach(cleanup);

describe("MT5 Bridge truth labels", () => {
  it("a settled disconnected state is not labelled 'Checking'", () => {
    statusResult = { isLoading: false, isError: false, data: {
      ...BASE_STATUS, route: "NONE", sharedMasterBridge: null,
      userSafeMessage: "MT5 bridge not connected for this user. Set up an MT5 connection in MT5 Bridge settings.",
    } };
    render(<MT5BridgePage />);
    expect(screen.queryByText("Bridge Checking")).toBeNull();
    expect(screen.queryByText("Checking")).toBeNull();
    expect(screen.getByText("Bridge Not connected")).toBeTruthy();
    expect(screen.getByTestId("bridge-state-copy").textContent).toContain("Set up an MT5 connection");
  });

  it("a shared-master user with a fresh master bridge sees it connected", () => {
    statusResult = { isLoading: false, isError: false, data: {
      ...BASE_STATUS, route: "SHARED_MASTER",
      sharedMasterBridge: { availability: "HEALTHY", connected: true, message: "Live bridge is healthy.", snapshotAgeSeconds: 4 },
      userSafeMessage: "You trade through the shared MT5 bridge. Live bridge is healthy.",
    } };
    render(<MT5BridgePage />);
    expect(screen.getByText("Bridge Healthy")).toBeTruthy();
    expect(screen.getByTestId("bridge-state-copy").textContent).not.toMatch(/not connected|unavailable/i);
  });

  it("a shared-master user with a stale master bridge sees 'Stale' and the server's reason", () => {
    statusResult = { isLoading: false, isError: false, data: {
      ...BASE_STATUS, route: "SHARED_MASTER",
      sharedMasterBridge: { availability: "STALE", connected: false, message: "Shared MT5 bridge last reported 600s ago — too old to count as connected.", snapshotAgeSeconds: 600 },
      userSafeMessage: "You trade through the shared MT5 bridge. Shared MT5 bridge last reported 600s ago — too old to count as connected.",
    } };
    render(<MT5BridgePage />);
    expect(screen.getByText("Bridge Stale")).toBeTruthy();
    expect(screen.getByTestId("bridge-state-copy").textContent).toContain("600s ago");
  });
});

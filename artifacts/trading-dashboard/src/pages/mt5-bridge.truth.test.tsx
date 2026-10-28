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
  tradingMode = { isLoading: false, isFrozen: false, isLiveShared: true, isLiveArmed: true, envelope: { userApprovalStatus: "APPROVED", liveExecutionArmed: true } };
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

// A fresh heartbeat on the user's own EA says the connection reports. It does
// not approve the account, and it does not measure the price feed, result
// reporting or position/account refresh.
describe("MT5 Bridge: heartbeat is not approval, feed or reporting", () => {
  function valuesFor(label: string): string[] {
    return screen.getAllByText(label).map((el) => {
      const row = el.closest("div")!;
      return (row.nextElementSibling?.textContent ?? row.parentElement?.textContent ?? "").replace(label, "").trim();
    });
  }

  beforeEach(() => {
    tradingMode = { isLoading: false, isFrozen: false, isLiveShared: false, envelope: { userApprovalStatus: "PENDING", liveExecutionArmed: false } };
    statusResult = { isLoading: false, isError: false, data: {
      ...BASE_STATUS, connected: true, mode: "DEMO", secondsSinceHeartbeat: 2, route: "OWN_CONNECTION",
      sharedMasterBridge: null, userSafeMessage: null,
    } };
  });

  it("a pending account is not shown with execution available", () => {
    render(<MT5BridgePage />);
    expect(screen.getAllByText("Pending").length).toBeGreaterThan(0);
    for (const v of valuesFor("Execution")) expect(v).not.toBe("Available");
    for (const el of screen.getAllByText("Order Routing")) expect(el.parentElement!.textContent).not.toContain("Available");
    expect(document.body.textContent).toContain("approval is pending");
    expect(document.body.textContent).not.toMatch(/account is approved/i);
  });

  it("market data, reporting and refresh are not asserted from the heartbeat", () => {
    render(<MT5BridgePage />);
    for (const label of ["Result Reporting", "Position Refresh", "Account Refresh", "Market Data"]) {
      for (const el of screen.getAllByText(label)) {
        const text = el.parentElement!.textContent ?? "";
        expect(text, label).not.toMatch(/Active|Connected/);
        expect(text, label).toContain("Not checked here");
      }
    }
    expect(screen.queryByText("Low")).toBeNull();
  });

  it("the user's own connection is not titled as the shared bridge", () => {
    render(<MT5BridgePage />);
    expect(screen.getByText("Your MT5 Connection")).toBeTruthy();
    expect(screen.queryByText("Shared MT5 Bridge", { selector: "h2" })).toBeNull();
  });
});

// After a good read, /mt5/status starts failing: React Query keeps the last
// data and sets isError. The page checked the cached `connected` before the
// "Status unknown" branch, so it kept saying Connected / Bridge Healthy /
// Execution Available from a read that is no longer current.
describe("MT5 Bridge when status polls start failing", () => {
  beforeEach(() => {
    tradingMode = { isLoading: false, isFrozen: false, isLiveShared: true, isLiveArmed: true, envelope: { userApprovalStatus: "APPROVED", liveExecutionArmed: true } };
    statusResult = { isLoading: false, isError: true, data: {
      ...BASE_STATUS, connected: true, mode: "LIVE", route: "OWN_CONNECTION", secondsSinceHeartbeat: 3,
      sharedMasterBridge: null, userSafeMessage: null,
    } };
  });

  it("says the status is unknown instead of Connected / Healthy", () => {
    render(<MT5BridgePage />);
    const body = document.body.textContent ?? "";
    expect(screen.queryByText("Connected")).toBeNull();
    expect(screen.queryByText("Bridge Healthy")).toBeNull();
    expect(screen.queryByText("Healthy")).toBeNull();
    expect(screen.getAllByText("Status unknown").length).toBeGreaterThan(0);
    expect(body).not.toMatch(/connection is reporting/i);
  });

  it("does not offer execution as available or show the cached heartbeat as current", () => {
    render(<MT5BridgePage />);
    for (const el of screen.getAllByText("Execution")) expect(el.parentElement!.textContent).not.toContain("Available");
    for (const el of screen.getAllByText("Order Routing")) expect(el.parentElement!.textContent).not.toContain("Available");
    for (const row of screen.queryAllByTestId("bridge-activity-row")) expect(row.textContent).not.toMatch(/Bridge heartbeat.*Connected/);
    expect(document.body.textContent).not.toContain("3 seconds ago");
  });
});

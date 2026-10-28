// MT5 Bridge: the heartbeat age is labelled as a heartbeat, not as "Last
// Sync". /mt5/status carries no account/position sync time, so the page must
// not stamp "Account snapshot synced" / "Position sync completed" with the
// heartbeat age.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

let statusResult: { data: unknown; isLoading: boolean; isError: boolean };

vi.mock("@workspace/api-client-react", () => ({
  useGetMt5Status: () => statusResult,
  useGetMeSharedAccountSummary: () => ({ data: null, isLoading: false }),
  getGetMt5StatusQueryKey: () => ["mt5-status"],
  getGetMeSharedAccountSummaryQueryKey: () => ["shared-summary"],
}));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock("@/hooks/useTradingMode", () => ({
  useTradingMode: () => ({ isLoading: false, isFrozen: false, isLiveShared: false, approvalStatus: "APPROVED" }),
}));
vi.mock("@/lib/assistant-name", () => ({ useAssistantName: () => ({ name: "Ruby" }) }));

const { default: MT5BridgePage } = await import("./mt5-bridge");

afterEach(cleanup);

describe("MT5 Bridge: heartbeat age is not 'Last Sync'", () => {
  it("own EA, connected, 3 s heartbeat and no sync fields", () => {
    statusResult = { isLoading: false, isError: false, data: {
      connected: true, mode: "DEMO", lastHeartbeatAt: new Date(Date.now() - 3000).toISOString(), secondsSinceHeartbeat: 3,
      accountType: "DEMO", openPositions: [], accountSnapshot: { account: "12345678", balance: 1000, equity: 1000, currency: "USD" },
      route: "OWN_CONNECTION", sharedMasterBridge: null, userSafeMessage: null,
    } };
    render(<MT5BridgePage />);
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("Last Sync");
    expect(screen.getAllByText(/Last heartbeat/).length).toBeGreaterThan(0);
    expect(text).toContain("3 seconds ago");
    // Snapshot / position rows are not claimed as synced at the heartbeat time.
    expect(text).not.toContain("Account snapshot synced");
    expect(text).not.toContain("Position sync completed");
    const rows = screen.getAllByTestId("bridge-activity-row").map((r) => r.textContent ?? "");
    for (const r of rows.filter((x) => /snapshot|position/i.test(x))) {
      expect(r).not.toContain("3 seconds ago");
      expect(r).not.toContain("Success");
    }
  });
});

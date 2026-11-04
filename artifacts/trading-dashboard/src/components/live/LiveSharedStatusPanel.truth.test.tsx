// Live Shared-Account Status: switches print "on" / "off" / "not reported"
// (never "?" or raw true/false), each command shows when it was made, the list
// says when it was read (it is not refreshed), and the blocked count is scoped
// to the commands shown instead of "on record".
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";

vi.mock("@workspace/api-client-react", () => ({
  useGetMeMasterLiveAccess: () => ({ isLoading: false, error: null, data: { canTrade: false, status: "PENDING" } }),
}));
vi.mock("@/hooks/useTradingMode", () => ({ useTradingMode: () => ({ shouldShowAdminDiagnostics: false }) }));
vi.mock("@/components/live/RejectionDisplay", () => ({ RejectionDisplay: () => null }));
const getCommands = vi.fn();
vi.mock("@/lib/api/liveShared", () => ({ getMyLiveSharedCommands: (...a: unknown[]) => getCommands(...a) }));

const { LiveSharedStatusPanel } = await import("./LiveSharedStatusPanel");

afterEach(() => { cleanup(); getCommands.mockReset(); });

const row = (id: string, status: string, createdAt?: string) => ({
  commandId: id, status, symbol: "EURUSD", side: "BUY", requestedVolume: 0.01, stopLoss: null, takeProfit: null,
  sourcePage: null, rejectionReason: null, confirmedAt: null, sentToMt5At: null, filledAt: null, brokerTicket: null, fillPrice: null,
  ...(createdAt ? { createdAt } : {}),
});

describe("LiveSharedStatusPanel truth", () => {
  it("unreported switches say 'not reported', not '?'", async () => {
    getCommands.mockResolvedValue({ commands: [] });
    render(<LiveSharedStatusPanel />);
    await waitFor(() => expect(screen.getByText("Master switch")).toBeTruthy());
    expect(document.body.textContent).not.toContain("?");
    expect(document.body.textContent).toContain("not reported");
  });

  it("reported switches read on / off", async () => {
    getCommands.mockResolvedValue({ commands: [], liveBrokerExecutionEnabled: false, liveExecutionDefaultDeny: true });
    render(<LiveSharedStatusPanel />);
    await waitFor(() => expect(screen.getByText("Master switch").parentElement?.textContent).toContain("off"));
    expect(screen.getByText("Default-deny").parentElement?.textContent).toContain("on");
  });

  it("each command shows its time, the list its read time, and the blocked count is scoped", async () => {
    getCommands.mockResolvedValue({ commands: [row("a", "LIVE_BLOCKED", "2026-10-28T08:15:00.000Z"), row("b", "LIVE_FILLED")] });
    render(<LiveSharedStatusPanel />);
    await waitFor(() => expect(screen.getByTestId("live-shared-command-time-a").textContent).toBe("10-28 08:15 UTC"));
    expect(screen.getByTestId("live-shared-command-time-b").textContent).toBe("time not reported");
    expect(screen.getByTestId("live-shared-commands-heading").textContent).toMatch(/Your last 2 commands, read .* UTC \(not refreshed on this panel\)/);
    expect(screen.getByTestId("live-shared-blocked-count").textContent).toBe("1 of these 2 commands was blocked.");
  });
});

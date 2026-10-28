// Regression: the Live Shared page counted every command row that carried a
// brokerTicket as an "open position". GET /trades/live-shared/commands
// returns the user's whole command history (USER_COMMAND_KEYS in
// tradesLiveShared.ts projects commandType, status, brokerTicket and closedAt
// for every row), and a CLOSE_LIVE_POSITION / MODIFY_LIVE_SLTP command's
// brokerTicket names the position it acted on (liveCommandPipeline.ts
// findGhostClosedPositionIds). So one opened-then-closed position plus one SL
// modify showed "Open Positions (3)" with three Close buttons and three
// editable SL/TP rows, although nothing was open.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";

let commands: Array<Record<string, unknown>> = [];

vi.mock("@/lib/api/liveShared", () => ({
  getMyLiveSharedCommands: async () => ({ commands }),
  getMyLiveSharedTrades: async () => ({ attributions: [] }),
  modifyLiveSharedTrade: vi.fn(),
  closeLiveSharedTrade: vi.fn(),
  cancelLiveSharedPendingOrder: vi.fn(),
}));
vi.mock("@/components/live/MasterLiveAccessGuard", () => ({
  useMasterLiveAccess: () => ({ loaded: true, canTrade: true, blockReason: null, message: null }),
}));
vi.mock("@/hooks/useTradingMode", () => ({
  useTradingMode: () => ({ envelope: {}, isLiveShared: true, cleanBlockedReason: null, cleanModeLabel: "LIVE" }),
}));
vi.mock("@/lib/assistant-name", () => ({ useAssistantName: () => ({ name: "Ruby" }) }));
vi.mock("@/components/live/LiveSharedTradeTicket", () => ({ LiveSharedTradeTicket: () => null }));
vi.mock("@/components/live/LiveSharedStatusPanel", () => ({ LiveSharedStatusPanel: () => null }));
vi.mock("@/components/live/TradeHealthPanel", () => ({ TradeHealthPanel: () => null }));

const { default: LiveSharedPage } = await import("./live-shared");

const row = (o: Record<string, unknown>) => ({
  symbol: "EURUSD", side: "BUY", requestedVolume: "0.10", stopLoss: null, takeProfit: null,
  sourcePage: null, rejectionReason: null, confirmedAt: null, sentToMt5At: null, filledAt: null,
  fillPrice: null, closedAt: null, ...o,
});

afterEach(() => cleanup());

async function openTab(id: string) {
  render(<LiveSharedPage />);
  fireEvent.mouseDown(screen.getByTestId(id), { button: 0, ctrlKey: false });
  // Let the lazy commands fetch resolve before asserting on counts.
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  await waitFor(() => expect(screen.queryByText("loading…")).toBeNull());
}

describe("live-shared open positions", () => {
  it("does not count a closed entry, its CLOSE command or a MODIFY command as open positions", async () => {
    commands = [
      row({ commandId: "a", commandType: "PLACE_LIVE_MARKET_ORDER", status: "LIVE_CLOSED", brokerTicket: "123", closedAt: "2026-10-27T10:00:00.000Z" }),
      row({ commandId: "b", commandType: "CLOSE_LIVE_POSITION", status: "LIVE_FILLED", brokerTicket: "123" }),
      row({ commandId: "c", commandType: "MODIFY_LIVE_SLTP", status: "LIVE_FILLED", brokerTicket: "123" }),
    ];
    await openTab("tab-open");
    await waitFor(() => expect(screen.getByText(/Open Positions \(0\)/)).toBeTruthy());
    expect(screen.queryByTestId("ls-close-123")).toBeNull();
  });

  it("drops a filled entry whose ticket a later filled CLOSE command names", async () => {
    commands = [
      row({ commandId: "b", commandType: "CLOSE_LIVE_POSITION", status: "LIVE_FILLED", brokerTicket: "123" }),
      row({ commandId: "a", commandType: "PLACE_LIVE_MARKET_ORDER", status: "LIVE_FILLED", brokerTicket: "123" }),
    ];
    await openTab("tab-open");
    await waitFor(() => expect(screen.getByText(/Open Positions \(0\)/)).toBeTruthy());
    expect(screen.queryByTestId("ls-close-123")).toBeNull();
  });

  it("lists a filled, unclosed entry once with a Close button", async () => {
    commands = [
      row({ commandId: "a", commandType: "PLACE_LIVE_MARKET_ORDER", status: "LIVE_FILLED", brokerTicket: "555" }),
      row({ commandId: "c", commandType: "MODIFY_LIVE_SLTP", status: "LIVE_FILLED", brokerTicket: "555" }),
    ];
    await openTab("tab-open");
    await waitFor(() => expect(screen.getByText(/Open Positions \(1\)/)).toBeTruthy());
    expect(screen.getAllByTestId("ls-close-555")).toHaveLength(1);
  });

  it("shows an order still awaiting a broker outcome separately, not as an open position", async () => {
    commands = [
      row({ commandId: "s", commandType: "PLACE_LIVE_MARKET_ORDER", status: "SENT_TO_MT5_LIVE", brokerTicket: null }),
    ];
    await openTab("tab-open");
    await waitFor(() => expect(screen.getByText(/Open Positions \(0\)/)).toBeTruthy());
    expect(screen.getByText(/Awaiting broker outcome \(1\)/)).toBeTruthy();
  });

  it("SL/TP Manager offers no editable rows for closed / CLOSE / MODIFY commands", async () => {
    commands = [
      row({ commandId: "a", commandType: "PLACE_LIVE_MARKET_ORDER", status: "LIVE_CLOSED", brokerTicket: "123", closedAt: "2026-10-27T10:00:00.000Z" }),
      row({ commandId: "b", commandType: "CLOSE_LIVE_POSITION", status: "LIVE_FILLED", brokerTicket: "123" }),
      row({ commandId: "c", commandType: "MODIFY_LIVE_SLTP", status: "LIVE_FILLED", brokerTicket: "123" }),
    ];
    await openTab("tab-sltp");
    await waitFor(() => expect(screen.getByText(/No open live positions/)).toBeTruthy());
    expect(screen.queryByTestId("sltp-submit-123")).toBeNull();
  });
});

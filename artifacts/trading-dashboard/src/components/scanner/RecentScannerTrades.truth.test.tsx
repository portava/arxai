// Recent Scanner Trades truth. The card reads ONE source: the user's MT5 demo
// command queue (/api/me/demo-commands). Its title and copy must describe that
// source, not the account mode:
//   * an admin in Live Shared mode (admin diagnostics on) sees demo commands —
//     the card must not be titled "— Live Shared" over them.
//
// The trading-mode hook is mocked per test; global fetch is stubbed (safeJson
// reads text()).

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

type Mode = {
  shouldShowDemoPaperCopy: boolean;
  shouldShowAdminDiagnostics: boolean;
  isLiveShared: boolean;
  isDemo: boolean;
  isPaper: boolean;
  isLiveArmed?: boolean;
  isLoading?: boolean;
  isModeUnknown?: boolean;
  envelope?: unknown;
};
let mode: Mode;
vi.mock("@/hooks/useTradingMode", () => ({ useTradingMode: () => mode }));

import { RecentScannerTrades } from "./RecentScannerTrades";

function stubItems(items: unknown[]) {
  const fetchMock = vi.fn(async () =>
    ({ ok: true, status: 200, text: async () => JSON.stringify({ items }) }) as unknown as Response,
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function demoCommand(over: Record<string, unknown> = {}) {
  return {
    commandId: "c1",
    status: "FILLED",
    reason: null,
    brokerTicket: "123456",
    fillPrice: 1.0851,
    fillVolume: 0.01,
    createdAt: new Date().toISOString(),
    payload: {
      source: "MARKET_SCANNER",
      symbol: "EURUSD",
      side: "BUY",
      volume: 0.01,
      signalContext: { confidenceScore: 72.4567, reasonForTrade: "Trend continuation" },
    },
    ...over,
  };
}

beforeEach(() => {
  mode = {
    shouldShowDemoPaperCopy: true,
    shouldShowAdminDiagnostics: false,
    isLiveShared: false,
    isDemo: true,
    isPaper: false,
    envelope: {},
  };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("RecentScannerTrades — title names the source that was read", () => {
  it("admin in Live Shared with diagnostics on: demo rows are not titled 'Live Shared'", async () => {
    mode = {
      shouldShowDemoPaperCopy: false,
      shouldShowAdminDiagnostics: true,
      isLiveShared: true,
      isDemo: false,
      isPaper: false,
      envelope: {},
    };
    const fetchMock = stubItems([demoCommand()]);
    render(<RecentScannerTrades />);
    expect(await screen.findByText("EURUSD")).toBeTruthy();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/me/demo-commands");
    const title = screen.getByTestId("recent-scanner-trades-title").textContent ?? "";
    expect(title).not.toContain("Live Shared");
    expect(title).toMatch(/MT5 Demo/);
    expect(screen.getByTestId("recent-scanner-trades-source").textContent).toMatch(/not.*Live Shared/i);
  });

  it("demo user: the title says MT5 Demo", async () => {
    stubItems([demoCommand()]);
    render(<RecentScannerTrades />);
    expect(await screen.findByText("EURUSD")).toBeTruthy();
    expect(screen.getByTestId("recent-scanner-trades-title").textContent).toMatch(/MT5 Demo/);
  });
});

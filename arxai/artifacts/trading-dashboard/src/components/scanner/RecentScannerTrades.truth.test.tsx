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

// Item: Paper title over MT5 demo commands; the Live Shared empty state
// promised history this card never loads; a loading mode read as Live Shared.
describe("RecentScannerTrades — paper, live and unknown modes say what this card reads", () => {
  it("paper user: demo-command rows are not titled 'Paper' and are named as MT5 demo orders", async () => {
    mode = {
      shouldShowDemoPaperCopy: true,
      shouldShowAdminDiagnostics: false,
      isLiveShared: false,
      isDemo: false,
      isPaper: true,
      envelope: {},
    };
    stubItems([demoCommand()]);
    render(<RecentScannerTrades />);
    expect(await screen.findByText("EURUSD")).toBeTruthy();
    const title = screen.getByTestId("recent-scanner-trades-title").textContent ?? "";
    expect(title).not.toContain("Paper");
    expect(title).toMatch(/MT5 Demo/);
    expect(screen.getByTestId("recent-scanner-trades-source").textContent).toMatch(/MT5 demo orders.*not paper trades/i);
  });

  it("non-admin Live Shared: nothing is fetched and the copy does not promise future history", async () => {
    mode = {
      shouldShowDemoPaperCopy: false,
      shouldShowAdminDiagnostics: false,
      isLiveShared: true,
      isDemo: false,
      isPaper: false,
      envelope: {},
    };
    const fetchMock = stubItems([demoCommand()]);
    render(<RecentScannerTrades />);
    const note = await screen.findByTestId("recent-scanner-trades-not-listed");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(note.textContent).not.toMatch(/will appear here/i);
    expect(note.textContent).toMatch(/MT5 demo orders only/i);
    expect(note.textContent).toMatch(/Live Shared.*not listed here/i);
    expect(screen.queryByTestId("recent-scanner-trades-empty")).toBeNull();
  });

  it("mode still loading: no Live Shared copy, says the mode is being checked", async () => {
    mode = {
      shouldShowDemoPaperCopy: false,
      shouldShowAdminDiagnostics: false,
      isLiveShared: false,
      isDemo: false,
      isPaper: false,
      isLoading: true,
      envelope: null,
    };
    stubItems([]);
    render(<RecentScannerTrades />);
    const note = await screen.findByTestId("recent-scanner-trades-not-listed");
    expect(note.textContent).not.toMatch(/Live Shared/);
    expect(note.textContent).toMatch(/checking your account mode/i);
  });

  it("mode could not be checked: says so, no Live Shared copy", async () => {
    mode = {
      shouldShowDemoPaperCopy: false,
      shouldShowAdminDiagnostics: false,
      isLiveShared: false,
      isDemo: false,
      isPaper: false,
      isModeUnknown: true,
      envelope: null,
    };
    stubItems([]);
    render(<RecentScannerTrades />);
    const note = await screen.findByTestId("recent-scanner-trades-not-listed");
    expect(note.textContent).not.toMatch(/Live Shared/);
    expect(note.textContent).toMatch(/could not be checked/i);
  });

  it("demo user with no scanner orders: the measured empty state is kept", async () => {
    stubItems([]);
    render(<RecentScannerTrades />);
    expect((await screen.findByTestId("recent-scanner-trades-empty")).textContent).toMatch(/No scanner-originated/);
  });
});

describe("RecentScannerTrades — no empty state before the first read", () => {
  it("while the first read is in flight the card says it is loading, not 'No scanner-originated trades yet'", async () => {
    let resolve: (r: Response) => void = () => {};
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((r) => { resolve = r; })));
    render(<RecentScannerTrades />);
    expect(screen.getByTestId("recent-scanner-trades-loading")).toBeTruthy();
    expect(screen.queryByTestId("recent-scanner-trades-empty")).toBeNull();
    resolve({ ok: true, status: 200, text: async () => JSON.stringify({ items: [] }) } as unknown as Response);
    expect(await screen.findByTestId("recent-scanner-trades-empty")).toBeTruthy();
    expect(screen.queryByTestId("recent-scanner-trades-loading")).toBeNull();
  });
});

// Item: rows showed a bare clock time (no date) and a raw confidence float.
describe("RecentScannerTrades — row time carries its date; strength carries its scale", () => {
  it("a command from yesterday shows its date, and 72.4567 renders as '72 / 100'", async () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60_000);
    yesterday.setHours(14, 5, 0, 0);
    stubItems([demoCommand({ createdAt: yesterday.toISOString() })]);
    render(<RecentScannerTrades />);
    expect(await screen.findByText("EURUSD")).toBeTruthy();
    const time = screen.getByTestId("recent-scanner-trade-time").textContent ?? "";
    expect(time).toContain(yesterday.toLocaleDateString(undefined, { month: "short", day: "numeric" }));
    expect(time).toContain(yesterday.toLocaleTimeString());
    const conf = screen.getByTestId("recent-scanner-trade-strength");
    expect(conf.textContent).toBe("72 / 100");
    expect(screen.queryByText("72.4567")).toBeNull();
  });

  it("an unreadable createdAt is shown as '—', never 'Invalid Date'", async () => {
    stubItems([demoCommand({ createdAt: "not-a-date" })]);
    render(<RecentScannerTrades />);
    expect(await screen.findByText("EURUSD")).toBeTruthy();
    expect(screen.getByTestId("recent-scanner-trade-time").textContent).toBe("—");
    expect(screen.queryByText(/Invalid Date/)).toBeNull();
  });
});

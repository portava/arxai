import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { RECENT_TRADES_DEGRADED_MESSAGE } from "@/lib/scannerResilience";

// Render proof for the Recent Scanner Trades card. The trading-mode hook is
// mocked so the card actually fetches (no QueryClientProvider needed), and
// global fetch is stubbed to drive the failure / success paths. The contract:
// a 502 with an empty body shows the honest degraded copy and NEVER leaks a raw
// "HTTP 502" / SyntaxError at the user.

vi.mock("@/hooks/useTradingMode", () => ({
  useTradingMode: () => ({
    shouldShowDemoPaperCopy: true,
    shouldShowAdminDiagnostics: false,
    isLiveShared: false,
    isDemo: true,
    isPaper: false,
  }),
}));

import { RecentScannerTrades } from "./RecentScannerTrades";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubFetch(res: { ok: boolean; status: number; body: string }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      ({
        ok: res.ok,
        status: res.status,
        text: async () => res.body,
      }) as unknown as Response,
    ),
  );
}

describe("RecentScannerTrades — degraded read", () => {
  it("shows honest degraded copy on a 502 with an empty body (never 'HTTP 502')", async () => {
    // Silence the operator console.debug so the test output stays clean.
    vi.spyOn(console, "debug").mockImplementation(() => {});
    stubFetch({ ok: false, status: 502, body: "" });
    render(<RecentScannerTrades />);

    expect(await screen.findByText(RECENT_TRADES_DEGRADED_MESSAGE)).toBeTruthy();
    expect(screen.queryByText(/HTTP 502/)).toBeNull();
    expect(screen.queryByText(/Unexpected end of JSON input/)).toBeNull();
    expect(screen.queryByText(/SyntaxError/)).toBeNull();
  });

  it("shows a visible in-progress state during retry, then clears on success", async () => {
    vi.spyOn(console, "debug").mockImplementation(() => {});
    // The retry fetch is held open via a deferred promise so we can assert the
    // in-progress UI (degraded copy still visible, button disabled + "Retrying…")
    // BEFORE the retry resolves.
    let resolveRetry: (r: Response) => void = () => {};
    const retryPromise = new Promise<Response>((resolve) => {
      resolveRetry = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 502, text: async () => "" } as unknown as Response)
      .mockReturnValueOnce(retryPromise);
    vi.stubGlobal("fetch", fetchMock);
    render(<RecentScannerTrades />);

    // Degraded copy + retry action both present.
    expect(await screen.findByText(RECENT_TRADES_DEGRADED_MESSAGE)).toBeTruthy();
    const retry = screen.getByTestId("recent-scanner-trades-retry");
    fireEvent.click(retry);

    // In-progress: the degraded block stays visible, the button is disabled and
    // labelled "Retrying…" while the retry request is pending.
    expect(await screen.findByText("Retrying…")).toBeTruthy();
    expect(screen.getByText(RECENT_TRADES_DEGRADED_MESSAGE)).toBeTruthy();
    expect((screen.getByTestId("recent-scanner-trades-retry") as HTMLButtonElement).disabled).toBe(true);

    // Resolve the retry with a healthy response → error clears, row renders.
    resolveRetry({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          items: [
            {
              commandId: "c1",
              status: "FILLED",
              reason: null,
              createdAt: new Date().toISOString(),
              payload: { source: "MARKET_SCANNER", symbol: "GBPUSD", side: "SELL", volume: 0.01 },
            },
          ],
        }),
    } as unknown as Response);

    expect(await screen.findByText("GBPUSD")).toBeTruthy();
    expect(screen.queryByText(RECENT_TRADES_DEGRADED_MESSAGE)).toBeNull();
    expect(screen.queryByText("Retrying…")).toBeNull();
  });

  it("renders scanner-originated rows on a healthy response", async () => {
    stubFetch({
      ok: true,
      status: 200,
      body: JSON.stringify({
        items: [
          {
            commandId: "c1",
            status: "FILLED",
            reason: null,
            createdAt: new Date().toISOString(),
            payload: { source: "MARKET_SCANNER", symbol: "EURUSD", side: "BUY", volume: 0.01 },
          },
        ],
      }),
    });
    render(<RecentScannerTrades />);

    expect(await screen.findByText("EURUSD")).toBeTruthy();
    expect(screen.queryByText(RECENT_TRADES_DEGRADED_MESSAGE)).toBeNull();
  });
});

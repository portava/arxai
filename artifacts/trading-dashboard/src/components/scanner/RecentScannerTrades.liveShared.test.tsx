// Render proof for the LIVE-ARMED, non-admin case of Recent Scanner Trades.
//
// `showDemoFeed = shouldShowDemoPaperCopy || shouldShowAdminDiagnostics`, and
// `shouldShowDemoPaperCopy` is `!isLiveShared && !isLiveArmed`. For a live-armed
// non-admin it is false, so load() returns immediately with setRows([]) and
// never fetches — the panel's only data source is /api/me/demo-commands, the
// DEMO queue. It then said "Live Shared scanner trade history will appear here
// once orders are placed", a promise it cannot keep: the live command
// projection deliberately redacts sourcePage (tradesLiveShared.ts
// USER_COMMAND_KEYS), so there is nothing here to filter scanner orders by.
// A trader placing scanner trades watched an empty panel forever and could not
// tell whether their orders had been recorded.
//
// The panel now says what it reads and links to where the live orders are.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

vi.mock("@/hooks/useTradingMode", () => ({
  useTradingMode: () => ({
    // Live-armed, non-admin: the exact combination that produced the dead panel.
    shouldShowDemoPaperCopy: false,
    shouldShowAdminDiagnostics: false,
    isLiveShared: true,
    isDemo: false,
    isPaper: false,
  }),
}));

import { RecentScannerTrades } from "./RecentScannerTrades";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("RecentScannerTrades — live-armed, non-admin", () => {
  it("does not promise live history it cannot show, and points at Live Shared", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<RecentScannerTrades />);

    const empty = await screen.findByTestId("recent-scanner-trades-empty");
    expect(empty.textContent).toMatch(/not available in Live Shared mode/);
    expect(empty.textContent).not.toMatch(/will appear here once orders are placed/);

    const link = screen.getByTestId("recent-scanner-trades-live-link");
    expect(link.getAttribute("href")).toMatch(/\/live-shared$/);
  });

  it("the card title names the feed it actually reads", async () => {
    vi.stubGlobal("fetch", vi.fn());
    render(<RecentScannerTrades />);
    const title = await screen.findByTestId("recent-scanner-trades-title");
    // Labelling this "Live Shared" claimed a live feed that is never fetched.
    expect(title.textContent).toMatch(/Demo queue only/);
  });

  it("makes no network call at all in this mode (so an empty list is not a failed read)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<RecentScannerTrades />);
    await screen.findByTestId("recent-scanner-trades-empty");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

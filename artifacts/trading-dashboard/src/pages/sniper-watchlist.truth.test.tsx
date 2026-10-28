// Sniper Watchlist: the empty state never claims trades it did not scan.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import SniperWatchlistPage, { sniperCoverage } from "./sniper-watchlist";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function serve(body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
}

describe("Sniper Watchlist coverage", () => {
  it("live positions that were not evaluated are named, and the copy does not claim them", async () => {
    serve({ items: [], routingMode: "USER_OWNED_MT5", scannedVenues: ["DEMO"], scannedCount: 0,
      notScanned: { venue: "LIVE", openPositions: 3 } });
    render(<SniperWatchlistPage />);
    const gap = await screen.findByTestId("watchlist-coverage-gap");
    expect(gap.textContent).toContain("3 live positions on your own MT5 are not covered");
    const empty = screen.getByTestId("watchlist-empty").textContent ?? "";
    expect(empty).not.toMatch(/None of your open trades/);
    expect(empty).not.toMatch(/continuously/);
  });

  it("an unreadable live ledger is 'could not be checked'", () => {
    expect(sniperCoverage({ scannedVenues: ["DEMO"], scannedCount: 1, notScanned: { venue: "LIVE", openPositions: null } }).gap)
      .toMatch(/could not be checked/);
  });

  it("a server that does not report coverage is not read as full coverage", () => {
    expect(sniperCoverage({}).scanned).toMatch(/not reported/);
  });

  // Regression: an unreadable trade was counted in scannedCount and unscored
  // signals were coerced to 0, so the page said "None of the scanned trades
  // are flagged" about trades nothing evaluated.
  it("does not call unread or unscored trades 'not flagged'", async () => {
    serve({ items: [], routingMode: "USER_OWNED_MT5", scannedVenues: ["DEMO"], scannedCount: 3,
      notScanned: { venue: "LIVE", openPositions: 0 },
      unresolvedCount: 1, evaluatedCount: 2,
      signalGaps: { closeUrgency: 1, profitGiveback: 1, stopTargetProximity: 1, reversalRisk: 2, fakeoutRisk: 2, volatilityRisk: 2 } });
    render(<SniperWatchlistPage />);
    const empty = (await screen.findByTestId("watchlist-empty")).textContent ?? "";
    expect(empty).not.toMatch(/None of the scanned trades are flagged/);
    expect(empty).toMatch(/checks that could run/);
    const notes = screen.getByTestId("watchlist-coverage-evaluation").textContent ?? "";
    expect(notes).toMatch(/1 of the 3 scanned trades could not be read/);
    expect(notes).toMatch(/close urgency on 1 of 2/);
    expect(notes).toMatch(/reversal risk on 2 of 2/);
  });

  it("a fully evaluated scan with nothing flagged still says none are flagged", async () => {
    serve({ items: [], routingMode: "USER_OWNED_MT5", scannedVenues: ["DEMO"], scannedCount: 2,
      notScanned: { venue: "LIVE", openPositions: 0 },
      unresolvedCount: 0, evaluatedCount: 2,
      signalGaps: { closeUrgency: 0, profitGiveback: 0, stopTargetProximity: 0, reversalRisk: 0, fakeoutRisk: 0, volatilityRisk: 0 } });
    render(<SniperWatchlistPage />);
    const empty = (await screen.findByTestId("watchlist-empty")).textContent ?? "";
    expect(empty).toMatch(/None of the scanned trades are flagged/);
    expect(screen.queryByTestId("watchlist-coverage-evaluation")).toBeNull();
  });

  it("a server that does not report evaluation coverage is not read as fully evaluated", async () => {
    serve({ items: [], routingMode: "USER_OWNED_MT5", scannedVenues: ["DEMO"], scannedCount: 2,
      notScanned: { venue: "LIVE", openPositions: 0 } });
    render(<SniperWatchlistPage />);
    const empty = (await screen.findByTestId("watchlist-empty")).textContent ?? "";
    expect(empty).not.toMatch(/None of the scanned trades are flagged for attention right now/);
    expect(empty).toMatch(/did not report/);
  });
});

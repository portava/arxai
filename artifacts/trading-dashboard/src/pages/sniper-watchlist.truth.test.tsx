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
});

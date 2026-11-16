// MT5 Setup "Open Demo Positions (MT5)": the server reports positionsMeasured
// false (and null counts) when this user's MT5 positions could not be read —
// the EA feed is install-wide, not stamped with a user. The card rendered
// "MT5 open: 0", a green "Orphan (not from ARX): 0", "Last sync: never" and
// "No open positions on the MT5 demo account." for that, and the same zeros
// when the request failed outright.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const { OpenDemoPositionsCard } = await import("./mt5-setup");

const NOTE = "Your MT5 account state could not be attributed to you.";

function stubSnapshot(status: number, body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response));
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("OpenDemoPositionsCard", () => {
  it("positions not read: counts say 'not checked' and the reason is shown, never 'No open positions'", async () => {
    stubSnapshot(200, {
      ok: true, safetyMode: "demo_only", liveExecutionBlocked: true, lastSyncAt: null,
      positionsMeasured: false, positionsNote: NOTE, openPositions: [],
      reconciliation: { mt5OpenPositionCount: null, arxMatchedPositionCount: null, arxOrphanPositionCount: null, filledCommandHistoryCount: 3, inSync: null },
    });
    render(<OpenDemoPositionsCard />);
    const note = await screen.findByTestId("text-open-positions-not-measured");
    expect(note.textContent).toContain(NOTE);
    expect(screen.getByTestId("badge-open-positions-count").textContent).toBe("MT5 open: not checked");
    expect(screen.getByTestId("badge-open-positions-matched").textContent).toBe("ARX matched: not checked");
    const orphans = screen.getByTestId("badge-open-positions-orphans");
    expect(orphans.textContent).toBe("Orphan (not from ARX): not checked");
    expect(orphans.className).not.toMatch(/text-success/);
    expect(screen.getByTestId("badge-open-positions-fill-history").textContent).toBe("ARX fill history: 3");
    expect(screen.getByTestId("text-open-positions-last-sync").textContent).toBe("Last sync: not read");
    expect(screen.getByTestId("card-open-demo-positions").textContent).not.toMatch(/No open positions/);
  });

  it("a failed request is 'could not be loaded', not zero counts", async () => {
    stubSnapshot(500, { error: "boom" });
    render(<OpenDemoPositionsCard />);
    await screen.findByTestId("text-open-positions-load-failed");
    expect(screen.getByTestId("badge-open-positions-count").textContent).toBe("MT5 open: not checked");
    expect(screen.getByTestId("badge-open-positions-fill-history").textContent).toBe("ARX fill history: not checked");
    expect(screen.getByTestId("text-open-positions-last-sync").textContent).toBe("Last sync: could not be loaded");
    const card = screen.getByTestId("card-open-demo-positions").textContent ?? "";
    expect(card).not.toMatch(/No open positions/);
    expect(card).not.toMatch(/: 0\b/);
  });

  it("a measured empty book still says 'No open positions'", async () => {
    stubSnapshot(200, {
      ok: true, lastSyncAt: new Date().toISOString(), positionsMeasured: true, positionsNote: null, openPositions: [],
      reconciliation: { mt5OpenPositionCount: 0, arxMatchedPositionCount: 0, arxOrphanPositionCount: 0, filledCommandHistoryCount: 0, inSync: true },
    });
    render(<OpenDemoPositionsCard />);
    await screen.findByTestId("text-open-positions-empty");
    expect(screen.getByTestId("badge-open-positions-count").textContent).toBe("MT5 open: 0");
  });

  it("a position with no P/L, stop or target shows dashes, not 0.00 / 0 / 0", async () => {
    stubSnapshot(200, {
      ok: true, lastSyncAt: new Date().toISOString(), positionsMeasured: true, positionsNote: null,
      openPositions: [{ brokerTicket: "77", symbol: "EURUSD", side: "BUY", volume: 0.1, entryPrice: 1.1, currentPrice: null,
        floatingPnL: null, stopLoss: null, takeProfit: null, openedAt: null, sourceCommandId: null, matchStatus: "ORPHAN_MT5_POSITION" }],
      reconciliation: { mt5OpenPositionCount: 1, arxMatchedPositionCount: 0, arxOrphanPositionCount: 1, filledCommandHistoryCount: 0, inSync: false },
    });
    render(<OpenDemoPositionsCard />);
    const row = await screen.findByTestId("row-open-position-77");
    expect(row.textContent).not.toMatch(/0\.00/);
    expect(row.textContent).toContain("— / —");
  });
});

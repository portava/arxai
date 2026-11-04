// Trade Health: the state ("Healthy") is computed from the synced price even
// when that price is stale or of unknown age; the server's per-position
// handshake reports it, but the panel never showed the handshake. A position
// whose sync / live price is not current must not read as a green "Healthy",
// and the panel says when the check ran.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

let payload: unknown = null;
vi.mock("@workspace/api-client-react", () => ({
  useGetMeTradeHealth: () => ({ isLoading: false, isError: false, data: payload }),
  getGetMeTradeHealthQueryKey: () => ["trade-health"],
}));

const { TradeHealthPanel, tradeHealthDataNotCurrent } = await import("./TradeHealthPanel");

afterEach(cleanup);

function assessment(handshake: unknown) {
  return {
    ticket: "T1", symbol: "EURUSD", side: "BUY", accountMode: "LIVE", matchesChartSymbol: true, entryPrice: 1.08,
    state: "healthy", headline: "This trade is healthy.", reasons: [], alert: false,
    tpProgress: { known: true, progressPct: 40, note: "" }, slDistance: { known: true, distancePrice: 0.002, bufferRemainingPct: 80, note: "" },
    breakEven: { suggested: false, note: "" }, partialClose: { suggested: false, note: "" },
    styleMatch: { detectedStyle: "intraday", note: "" }, alternatives: [], handshake,
  };
}
function serve(a: unknown) {
  payload = { evaluatedAt: "2026-10-28T09:10:11.000Z", chartSymbol: "EURUSD", assessments: [a], conflicts: [], correlations: [], overtrading: [], overlays: [], summary: "1 open." };
}

const STALE = {
  overallStatus: "WARN", userFacingMessage: "This trade is monitored, but some inputs are limited.", warnings: [],
  checks: [
    { key: "positionInSync", status: "PASS", detail: "The position is present in the latest sync." },
    { key: "freshness", status: "FAIL", detail: "The position data is stale." },
    { key: "currentPriceFresh", status: "WARN", detail: "The live price is older than ideal." },
  ],
};

describe("Trade Health freshness", () => {
  it("a healthy read on stale position data is not shown as plain Healthy", () => {
    serve(assessment(STALE));
    render(<TradeHealthPanel chartSymbol="EURUSD" />);
    expect(screen.getByTestId("trade-health-state-T1").textContent).toBe("Healthy (data not current)");
    const note = screen.getByTestId("trade-health-not-current-T1").textContent ?? "";
    expect(note).toContain("The position data is stale.");
    expect(note).toContain("The live price is older than ideal.");
  });

  it("a missing handshake is treated as unconfirmed", () => {
    expect(tradeHealthDataNotCurrent({ handshake: undefined as never })).not.toBeNull();
  });

  it("fresh data keeps the plain state and the panel says when it checked", () => {
    serve(assessment({ overallStatus: "PASS", userFacingMessage: "", warnings: [], checks: [
      { key: "freshness", status: "PASS", detail: "" }, { key: "currentPriceFresh", status: "PASS", detail: "" },
    ] }));
    render(<TradeHealthPanel chartSymbol="EURUSD" />);
    expect(screen.getByTestId("trade-health-state-T1").textContent).toBe("Healthy");
    expect(screen.getByTestId("trade-health-evaluated-at").textContent).toBe("Checked 09:10:11 UTC from your synced positions.");
  });
});

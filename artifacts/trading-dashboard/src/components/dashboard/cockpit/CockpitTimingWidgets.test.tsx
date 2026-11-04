// Cockpit timing widgets — the footer's age is the read's own generatedAt and
// its source line comes from each row's dataQuality, never a fixed "live
// market provider" string or the browser's fetch time.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

const h = vi.hoisted(() => ({ result: { data: undefined as unknown, isLoading: false, isError: false, dataUpdatedAt: 0 } }));

vi.mock("wouter", () => ({
  Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string; [k: string]: unknown }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));
vi.mock("@workspace/domain/market", () => ({ isApprovedArxMarket: () => true }));
vi.mock("@workspace/api-client-react", () => ({
  useGetTimingBrainMulti: () => h.result,
  getGetTimingBrainMultiQueryKey: (p: unknown) => ["/api/me/timing-brain/multi", p],
}));

import { BestMarketsCard, AvoidMarketsCard, timingFooter } from "./CockpitTimingWidgets";

const TEN_MIN = 10 * 60_000;

function row(over: Record<string, unknown> = {}) {
  return {
    symbol: "EURUSD",
    timeframe: "M15",
    generatedAt: new Date(Date.now() - TEN_MIN).toISOString(),
    entryPermission: "GO",
    timingGrade: "A",
    heatState: "CLEAN_MOMENTUM",
    bestAction: "WAIT_PULLBACK",
    heatScore: 70,
    tradeabilityScore: 72,
    dangerScore: 20,
    dataQuality: { label: "partial", hasCandleData: true, hasQuoteData: false, hasNewsData: true, hasBroadFlowData: true, note: "Partial data: live quote unavailable." },
    ...over,
  };
}

function setResults(results: unknown[]) {
  h.result = { data: { results }, isLoading: false, isError: false, dataUpdatedAt: Date.now() };
}

beforeEach(() => setResults([row()]));
afterEach(() => cleanup());

describe("BestMarketsCard footer", () => {
  it("does not claim 'live market provider' and ages from the read's generatedAt, not the fetch time", () => {
    render(<BestMarketsCard />);
    const footer = screen.getByTestId("timing-footer").textContent ?? "";
    expect(footer).not.toMatch(/live market provider/i);
    expect(footer).not.toMatch(/\b\ds ago/);
    expect(footer).toBe("M15 timing reads computed 10m ago · current candles for 1 of 1 markets, 0 with a live quote");
  });

  it("marks a partial-data row and never promotes a session-only estimate to 'best now'", () => {
    setResults([
      row(),
      row({ symbol: "GBPUSD", dataQuality: { label: "basic_timing_estimate", hasCandleData: false, hasQuoteData: false, hasNewsData: false, hasBroadFlowData: false, note: "" } }),
    ]);
    render(<BestMarketsCard />);
    expect(screen.getByText("EURUSD")).toBeTruthy();
    expect(screen.queryByText("GBPUSD")).toBeNull();
    expect(screen.getByTestId("timing-row-caveat").textContent).toBe("Partial data");
  });

  it("says why it is empty when the only A/B read is a session-only estimate", () => {
    setResults([row({ dataQuality: { label: "basic_timing_estimate", hasCandleData: false } })]);
    render(<BestMarketsCard />);
    expect(screen.getByTestId("best-markets-skipped").textContent).toContain("session-only estimate");
  });
});

describe("AvoidMarketsCard", () => {
  it("with no reads does not say there are no red flags", () => {
    setResults([]);
    render(<AvoidMarketsCard />);
    expect(screen.getByTestId("avoid-markets-empty").textContent).toBe("No timing reads — red flags could not be checked.");
    expect(screen.getByTestId("timing-footer").textContent).toBe("No timing reads returned.");
  });

  it("never lists an estimate-only red flag; names it as not measured", () => {
    setResults([row({ entryPermission: "STAND_DOWN", timingGrade: "D", dataQuality: { label: "basic_timing_estimate", hasCandleData: false } })]);
    render(<AvoidMarketsCard />);
    expect(screen.getByTestId("cockpit-avoid-markets").querySelector("li")).toBeNull();
    expect(screen.getByTestId("timing-unmeasured").textContent).toContain("EURUSD");
    expect(screen.getByTestId("avoid-markets-empty").textContent).toBe("Timing not measured — no current candles.");
  });

  it("labels a partial-data red flag", () => {
    setResults([row({ entryPermission: "STAND_DOWN", timingGrade: "D" })]);
    render(<AvoidMarketsCard />);
    expect(screen.getByTestId("timing-row-caveat").textContent).toBe("Partial data");
  });
});

describe("timingFooter", () => {
  it("uses the OLDEST generatedAt and reports missing read times plainly", () => {
    const now = Date.parse("2026-10-28T12:00:00Z");
    const a = row({ generatedAt: "2026-10-28T11:59:30Z", dataQuality: { label: "real", hasCandleData: true } });
    const b = row({ generatedAt: "2026-10-28T11:55:00Z", dataQuality: { label: "real", hasCandleData: true } });
    expect(timingFooter([a, b], { now })).toBe("M15 timing reads computed 5m ago · current candles for 2 of 2 markets, 2 with a live quote");
    expect(timingFooter([row({ generatedAt: undefined })], { now })).toBe("M15 timing reads · read time not reported · current candles for 1 of 1 markets, 0 with a live quote");
    expect(timingFooter([], { isError: true })).toBe("Timing reads could not be loaded.");
  });
});

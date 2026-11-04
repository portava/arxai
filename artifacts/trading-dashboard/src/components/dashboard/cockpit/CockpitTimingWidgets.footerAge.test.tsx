// Cockpit timing footer age — Best Markets / Avoid Markets poll every 90 s.
// The footer computed "computed Xs ago" from generatedAt only when the card
// re-rendered, and nothing re-rendered it between polls, so "computed 4s ago"
// stayed on screen for up to ~90 s. After a failed refetch React Query keeps
// the old rows, so the frozen age stayed with no note that the refresh failed.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";

const h = vi.hoisted(() => ({ result: { data: undefined as unknown, isLoading: false, isError: false } }));

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

const NOW = Date.parse("2026-10-28T10:00:00.000Z");

function row(over: Record<string, unknown> = {}) {
  return {
    symbol: "EURUSD",
    timeframe: "M15",
    generatedAt: new Date(NOW).toISOString(),
    entryPermission: "GO",
    timingGrade: "A",
    heatState: "CLEAN_MOMENTUM",
    bestAction: "WAIT_PULLBACK",
    heatScore: 70,
    tradeabilityScore: 72,
    dangerScore: 20,
    dataQuality: { label: "real", hasCandleData: true, hasQuoteData: true, hasNewsData: true, hasBroadFlowData: true, note: "" },
    ...over,
  };
}

function footer(): string {
  return screen.getByTestId("timing-footer").textContent ?? "";
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(NOW);
  h.result = { data: { results: [row()] }, isLoading: false, isError: false };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("cockpit timing footer age keeps counting between polls", () => {
  it("Best Markets: the same data 60 s later reads 1m ago, not 0s ago", () => {
    render(<BestMarketsCard />);
    expect(footer()).toContain("computed 0s ago");
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(footer()).not.toContain("0s ago");
    expect(footer()).toContain("computed 1m ago");
  });

  it("Avoid Markets: the same data 45 s later reads 45s ago", () => {
    h.result = { data: { results: [row({ entryPermission: "NO_TRADE", timingGrade: "D" })] }, isLoading: false, isError: false };
    render(<AvoidMarketsCard />);
    act(() => { vi.advanceTimersByTime(45_000); });
    expect(footer()).toContain("computed 45s ago");
  });
});

describe("a failed refetch with old rows still on screen says so", () => {
  it("footer names the failed refresh and the old rows' true age", () => {
    h.result = { data: { results: [row({ generatedAt: new Date(NOW - 5 * 60_000).toISOString() })] }, isLoading: false, isError: true };
    render(<BestMarketsCard />);
    expect(footer()).toMatch(/^Last refresh failed · /);
    expect(footer()).toContain("computed 5m ago");
  });

  it("timingFooter: isError with rows is not silent; without isError it is unchanged", () => {
    const rows = [row()];
    expect(timingFooter(rows, { isError: true, now: NOW })).toBe(
      "Last refresh failed · M15 timing reads computed 0s ago · current candles for 1 of 1 markets, 1 with a live quote",
    );
    expect(timingFooter(rows, { now: NOW })).toBe(
      "M15 timing reads computed 0s ago · current candles for 1 of 1 markets, 1 with a live quote",
    );
  });
});

// Truth regression: a timing read computed with no current candles and no
// quote (session constants only) must not be listed under "Avoid Right Now" /
// "Best Markets Now" as if it were measured, and the footer must not claim a
// live market provider from the browser's fetch time.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

const h = vi.hoisted(() => ({ results: [] as unknown[] }));

vi.mock("wouter", () => ({
  Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string; [k: string]: unknown }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

vi.mock("@workspace/api-client-react", () => ({
  useGetTimingBrainMulti: () => ({ data: { results: h.results }, isLoading: false, dataUpdatedAt: Date.now() - 3000 }),
  getGetTimingBrainMultiQueryKey: () => ["timing-multi"],
}));

import { AvoidMarketsCard, BestMarketsCard } from "./CockpitTimingWidgets";

afterEach(() => cleanup());

function read(symbol: string, measured: boolean, over: Record<string, unknown> = {}) {
  return {
    symbol,
    generatedAt: new Date(Date.now() - 20_000).toISOString(),
    timingGrade: measured ? "D" : "F",
    entryPermission: measured ? "NO_TRADE" : "STAND_DOWN",
    heatState: "COOL",
    heatScore: 35,
    tradeabilityScore: 20,
    dangerScore: 36,
    bestAction: "STAND_DOWN",
    dataQuality: measured
      ? { label: "real", hasCandleData: true, hasQuoteData: true, hasNewsData: true, hasBroadFlowData: true, note: "" }
      : { label: "basic_timing_estimate", hasCandleData: false, hasQuoteData: false, hasNewsData: false, hasBroadFlowData: false, note: "" },
    ...over,
  };
}

describe("Avoid Right Now — unmeasured timing reads", () => {
  it("does not list a session-constant read as an avoid row and names it as not measured", () => {
    h.results = [read("EURUSD", false)];
    render(<AvoidMarketsCard />);
    const card = screen.getByTestId("cockpit-avoid-markets");
    expect(card.querySelector("li")).toBeNull();
    expect(screen.getByTestId("timing-unmeasured").textContent).toContain("EURUSD");
    const footer = screen.getByTestId("timing-footer").textContent ?? "";
    expect(footer).not.toMatch(/live market provider/i);
    expect(footer).toMatch(/not measured/i);
    expect(screen.queryByText("No major red flags right now.")).toBeNull();
  });

  it("lists measured reads and dates the footer from the reads' generatedAt", () => {
    h.results = [read("EURUSD", false), read("GBPUSD", true)];
    render(<AvoidMarketsCard />);
    const items = Array.from(screen.getByTestId("cockpit-avoid-markets").querySelectorAll("li"));
    expect(items.map((li) => li.textContent)).toEqual([expect.stringContaining("GBPUSD")]);
    const footer = screen.getByTestId("timing-footer").textContent ?? "";
    expect(footer).toMatch(/1 of 2 markets/);
    expect(footer).toMatch(/computed 20s ago/);
  });
});

describe("Best Markets Now — unmeasured timing reads", () => {
  it("never lists an unmeasured GO/A read", () => {
    h.results = [read("EURUSD", false, { entryPermission: "GO", timingGrade: "A" })];
    render(<BestMarketsCard />);
    expect(screen.getByTestId("cockpit-best-markets").querySelector("li")).toBeNull();
    expect(screen.getByText(/Timing not measured/)).toBeTruthy();
  });
});

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
    expect(footer).toBe("M15 timing reads computed 10m ago · current candles for 1 of 5 requested markets, 0 with a live quote");
  });

  // Codex line (stricter): only a provider-backed read (current candles AND a
  // live quote) is promoted to a candidate. A partial-data read is not listed
  // at all — it is named as not ranked — and a session-only estimate is never
  // promoted either. (Truth listed the partial row with a "Partial data" tag.)
  it("never promotes a partial-data row or a session-only estimate to 'best now'; names both", () => {
    setResults([
      row(),
      row({ symbol: "GBPUSD", dataQuality: { label: "basic_timing_estimate", hasCandleData: false, hasQuoteData: false, hasNewsData: false, hasBroadFlowData: false, note: "" } }),
    ]);
    render(<BestMarketsCard />);
    expect(screen.getByTestId("cockpit-best-markets").querySelector("li")).toBeNull();
    expect(screen.queryByText("EURUSD")).toBeNull();
    expect(screen.queryByText("GBPUSD")).toBeNull();
    expect(screen.getByTestId("timing-no-quote").textContent).toContain("EURUSD");
    expect(screen.getByTestId("timing-unmeasured").textContent).toContain("GBPUSD");
    expect(screen.getByTestId("best-markets-skipped").textContent).toContain("session-only estimate");
    expect(screen.getByTestId("best-markets-skipped-no-quote").textContent).toContain("no live quote");
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
    // Codex line copy for "no usable reads": unavailable, cautions not assessed.
    expect(screen.getByTestId("avoid-markets-empty").textContent).toBe("Timing data unavailable. Market cautions have not been assessed.");
    expect(screen.queryByText(/No major red flags|No listed cautions/)).toBeNull();
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

// Coverage is measured against the 5 requested markets, not the rows that came
// back. The server omits failed markets; when only 2 partial-data reads return
// (none with a live quote), the omitted markets must still be named and both
// cards must flag partial coverage, so "no listed cautions" is never read as
// covering every market.
describe("coverage against the requested markets", () => {
  const MISSING = "USDJPY, XAUUSD, BTCUSD";
  function twoPartialReads() {
    setResults([row({ entryPermission: "WAIT_FOR_ENTRY", timingGrade: "C" }), row({ symbol: "GBPUSD", entryPermission: "WAIT_FOR_ENTRY", timingGrade: "C" })]);
  }
  function allFiveProviderBacked() {
    setResults(["EURUSD", "GBPUSD", "USDJPY", "XAUUSD", "BTCUSD"].map((symbol) => row({
      symbol,
      dataQuality: { label: "real", hasCandleData: true, hasQuoteData: true, hasNewsData: true, hasBroadFlowData: true, note: "" },
    })));
  }

  it("Timing Cautions: 2 of 5 partial reads name the omitted markets, flag partial coverage, and count 2 of 5 in the footer", () => {
    twoPartialReads();
    render(<AvoidMarketsCard />);
    expect(screen.getByTestId("avoid-markets-empty").textContent).toBe("No listed cautions in 2 measured timing reads.");
    expect(screen.getByText(/Partial coverage/)).toBeTruthy();
    expect(screen.getByTestId("timing-missing").textContent).toBe(`No usable read returned: ${MISSING}`);
    expect(screen.getByTestId("timing-footer").textContent).toBe("M15 timing reads computed 10m ago · current candles for 2 of 5 requested markets, 0 with a live quote");
  });

  it("Timing Cautions compact: flags partial coverage when 2 of 5 come back as partial reads", () => {
    twoPartialReads();
    render(<AvoidMarketsCard compactWorkspace />);
    expect(screen.getByText("No listed caution · not an all-clear")).toBeTruthy();
    expect(screen.getByText("Partial coverage")).toBeTruthy();
  });

  it("Timing Candidates: flags partial coverage and names the omitted markets when none of the reads is provider-backed", () => {
    twoPartialReads();
    render(<BestMarketsCard />);
    expect(screen.getByText(/Partial coverage/)).toBeTruthy();
    expect(screen.getByTestId("timing-missing").textContent).toBe(`No usable read returned: ${MISSING}`);
    expect(screen.getByTestId("timing-footer").textContent).toContain("2 of 5 requested markets, 0 with a live quote");
  });

  it("Timing Candidates compact: flags partial coverage when none of the reads is provider-backed", () => {
    twoPartialReads();
    render(<BestMarketsCard compactWorkspace />);
    expect(screen.getByText("Not measured · no provider-backed reads")).toBeTruthy();
    expect(screen.getByText("Partial coverage")).toBeTruthy();
  });

  it("a malformed row for a requested market counts as no usable read", () => {
    setResults([row(), row({ symbol: "GBPUSD", timingGrade: "Z" })]);
    render(<AvoidMarketsCard />);
    expect(screen.getByTestId("timing-missing").textContent).toBe("No usable read returned: GBPUSD, USDJPY, XAUUSD, BTCUSD");
    expect(screen.getByTestId("timing-footer").textContent).toContain("1 of 5 requested markets");
  });

  it("all 5 provider-backed reads: no partial-coverage flag and no missing markets", () => {
    allFiveProviderBacked();
    render(<><BestMarketsCard /><AvoidMarketsCard /></>);
    expect(screen.queryByText(/Partial coverage/)).toBeNull();
    expect(screen.queryByTestId("timing-missing")).toBeNull();
    for (const f of screen.getAllByTestId("timing-footer")) {
      expect(f.textContent).toBe("M15 timing reads computed 10m ago · current candles for 5 of 5 requested markets, 5 with a live quote");
    }
  });
});

describe("timingFooter", () => {
  it("uses the OLDEST generatedAt and reports missing read times plainly", () => {
    const now = Date.parse("2026-10-28T12:00:00Z");
    const a = row({ generatedAt: "2026-10-28T11:59:30Z", dataQuality: { label: "real", hasCandleData: true } });
    const b = row({ generatedAt: "2026-10-28T11:55:00Z", dataQuality: { label: "real", hasCandleData: true } });
    expect(timingFooter([a, b], { now })).toBe("M15 timing reads computed 5m ago · current candles for 2 of 5 requested markets, 2 with a live quote");
    expect(timingFooter([row({ generatedAt: undefined })], { now })).toBe("M15 timing reads · read time not reported · current candles for 1 of 5 requested markets, 0 with a live quote");
    expect(timingFooter([], { isError: true })).toBe("Timing reads could not be loaded.");
  });
});

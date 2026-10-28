// Timing Intelligence truth (2026-10-28):
//   1. A timing read past Truth's 30-second component lifetime (the server's
//      COMPONENT_BUILD_TTL_MS) is not current advice. After a hidden tab
//      (polling paused, refetchOnWindowFocus false) the card used to show the
//      grade and a GO permission under "Live data · updated 10m 0s ago". It
//      now withholds grade / permission / scores, says the read expired, and
//      asks for a new read.
//   2. "Live data" described the data quality at compute time, not the data
//      now; the label says what it is ("Real data · computed …").
//   3. On a 15m chart, the chart-header chip and the card read the SAME M15
//      timing for the same symbol. They used different client query keys and
//      server cache entries ({timeframe:"M15"} vs {tz}), so they could disagree
//      for cache reasons alone. Both now request identical params and consume
//      one query.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

const FULL_GATE = {
  truth: { analysis: { level: "full" } }, level: "full", isFull: true, downgraded: false, reason: null,
};
vi.mock("@/hooks/useScannerReadGate", () => ({ useScannerReadGate: () => FULL_GATE }));
vi.mock("@/components/scanner/ScannerReadGate", () => ({ ScannerReadGate: () => null }));
vi.mock("@/hooks/useScannerTimeframe", () => ({ useScannerTimeframe: () => ["15m", () => {}] }));
vi.mock("@/hooks/useSymbolTruth", () => ({ useSymbolTruth: () => ({ news: null }) }));
vi.mock("@/lib/assistant-name", () => ({ useAssistantName: () => ({ name: "Ruby" }) }));

type TimingParams = Record<string, string> | undefined;
const timingFn = vi.fn<(symbol: string, params: TimingParams) => Promise<Record<string, unknown>>>();

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    useGetTimingBrain: (
      symbol: string,
      params: TimingParams,
      options: { query: { queryKey: readonly unknown[]; enabled?: boolean } },
    ) => useQuery({
      queryKey: options.query.queryKey,
      enabled: options.query.enabled ?? true,
      queryFn: () => timingFn(symbol, params),
      retry: false,
    }),
  };
});

import { TimingIntelligenceCard } from "./TimingIntelligenceCard";
import { ChartTimingChip } from "./ChartTimingChip";

function timingRead(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    symbol: "EURUSD",
    timeframe: "M15",
    timingGrade: "A",
    entryPermission: "GO",
    pressureBias: "BUY",
    heatScore: 70,
    tradeabilityScore: 72,
    dangerScore: 20,
    bestAction: "BUY",
    actionReason: "Session momentum aligned.",
    session: { sessionName: "London", isKillZoneActive: false, sessionDescription: "" },
    dataQuality: { label: "real", note: "", hasCandleData: true },
    generatedAt: new Date().toISOString(),
    ...over,
  };
}

let client: QueryClient;
function withClient(children: ReactNode) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  window.localStorage.clear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  timingFn.mockReset();
});
afterEach(() => {
  cleanup();
  client.clear();
});

describe("Timing Intelligence — advice lifetime", () => {
  it("a GO read computed 10 minutes ago is withheld as expired, not shown as current", async () => {
    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    // First (and any re-)read returns the same old read: the card must never
    // promote it to current.
    timingFn.mockResolvedValue(timingRead({ generatedAt: old }));
    render(withClient(<TimingIntelligenceCard symbol="EURUSD" />));
    await waitFor(() => expect(screen.getByTestId("timing-intelligence-expired")).toBeTruthy());
    expect(screen.queryByTestId("timing-intelligence-permission")).toBeNull();
    expect(screen.queryByTestId("timing-intelligence-grade")).toBeNull();
    expect(screen.queryByTestId("timing-intelligence-scores")).toBeNull();
    expect(screen.queryByText(/Live data/)).toBeNull();
    expect(screen.getByTestId("timing-intelligence-expired").textContent).toMatch(/10m 0s ago/);
    // It asks for a current read once (not in a loop).
    await waitFor(() => expect(timingFn.mock.calls.length).toBeGreaterThanOrEqual(2));
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(timingFn.mock.calls.length).toBe(2);
  });

  it("a read without a valid generatedAt is treated as expired (fail-closed)", async () => {
    timingFn.mockResolvedValue(timingRead({ generatedAt: "not-a-time" }));
    render(withClient(<TimingIntelligenceCard symbol="EURUSD" />));
    await waitFor(() => expect(screen.getByTestId("timing-intelligence-expired")).toBeTruthy());
    expect(screen.queryByTestId("timing-intelligence-permission")).toBeNull();
  });

  it("a fresh read shows grade and permission, labelled as computed data, never 'Live data'", async () => {
    // "Real data" needs a current closed candle behind the read (marketEvidence);
    // the line names the recalculation clock as "calculated", not the data age.
    timingFn.mockResolvedValue(timingRead({
      generatedAt: new Date(Date.now() - 5_000).toISOString(),
      marketEvidence: { timeframe: "M15", lastClosedCandleAt: new Date(Date.now() - 6 * 60_000).toISOString() },
    }));
    render(withClient(<TimingIntelligenceCard symbol="EURUSD" />));
    await waitFor(() => expect(screen.getByTestId("timing-intelligence-permission").textContent).toBe("Go"));
    const quality = screen.getByTestId("timing-intelligence-quality").textContent ?? "";
    expect(quality).not.toContain("Live data");
    expect(quality).toMatch(/Real data · calculated \d+s ago · last closed 15m candle ended 6m ago/);
  });
});

describe("Timing chip and card on a 15m chart share one M15 read", () => {
  it("both request identical params and show the same grade and permission", async () => {
    // A cache split would be visible as different grades per request shape.
    timingFn.mockImplementation(async (_symbol, params) =>
      params && "tz" in params && params.timeframe === "M15"
        ? timingRead({ timingGrade: "A", entryPermission: "GO" })
        : timingRead({ timingGrade: "C", entryPermission: "WAIT_FOR_ENTRY" }),
    );
    render(withClient(
      <>
        <ChartTimingChip symbol="EURUSD" apiTf="M15" timeframeLabel="15m" />
        <TimingIntelligenceCard symbol="EURUSD" />
      </>,
    ));
    await waitFor(() => expect(screen.getByTestId("timing-intelligence-grade")).toBeTruthy());
    await waitFor(() => expect(screen.getByTestId("scanner-chart-timing-chip")).toBeTruthy());
    const shapes = new Set(timingFn.mock.calls.map(([, p]) => JSON.stringify(p, Object.keys(p ?? {}).sort())));
    expect(shapes.size).toBe(1);
    const grade = screen.getByTestId("timing-intelligence-grade").textContent;
    expect(screen.getByTestId("scanner-chart-timing-chip").textContent).toContain(`· ${grade} ·`);
    expect(screen.getByTestId("timing-intelligence-permission").textContent).toBe("Go");
    expect(screen.getByTestId("scanner-chart-timing-chip").textContent).toContain("Go");
  });

  it("the chip hides an expired read too", async () => {
    timingFn.mockResolvedValue(timingRead({ generatedAt: new Date(Date.now() - 10 * 60_000).toISOString() }));
    render(withClient(<ChartTimingChip symbol="EURUSD" apiTf="M15" timeframeLabel="15m" />));
    await waitFor(() => expect(timingFn).toHaveBeenCalled());
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(screen.queryByTestId("scanner-chart-timing-chip")).toBeNull();
  });
});

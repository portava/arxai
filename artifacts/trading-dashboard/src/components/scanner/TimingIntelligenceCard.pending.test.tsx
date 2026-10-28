// Truth audit 2026-10-28 — while the shared candles truth has not landed the
// gate is pending, not historical. The Timing Intelligence body must not call
// that read "historical" while the compact gate in the same card header says
// "Confirming market data".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

let gateState: Record<string, unknown> = {};
vi.mock("@/hooks/useScannerReadGate", () => ({ useScannerReadGate: () => gateState }));
vi.mock("@/hooks/useScannerTimeframe", () => ({ useScannerTimeframe: () => ["15m", () => {}] }));
vi.mock("@/hooks/useSymbolTruth", () => ({ useSymbolTruth: () => ({ news: null }) }));
vi.mock("@/lib/assistant-name", () => ({ useAssistantName: () => ({ name: "Ruby" }) }));
vi.mock("@workspace/api-client-react", () => ({
  useGetTimingBrain: () => ({
    data: { timeframe: "M15", timingGrade: "B", dataQuality: { label: "real", note: "" } },
    isLoading: false, isFetching: false, isError: false, refetch: vi.fn(),
  }),
  getGetTimingBrainQueryKey: () => ["timing-brain"],
}));

import { TimingIntelligenceCard } from "./TimingIntelligenceCard";

beforeEach(() => { window.localStorage.clear(); });
afterEach(() => cleanup());

describe("Timing Intelligence — pending shared truth", () => {
  it("says it is confirming market data, matching the compact gate, never 'historical'", () => {
    gateState = {
      truth: null, level: null, isFull: false, downgraded: true,
      reason: "Confirming this market's live feed — directional reads and trade ideas are withheld.",
    };
    render(<TimingIntelligenceCard symbol="EURUSD" />);
    expect(screen.getByTestId("scanner-read-gate-compact").textContent).toContain("Confirming market data");
    const body = screen.getByTestId("timing-intelligence-downgraded").textContent ?? "";
    expect(body).not.toMatch(/historical/i);
    expect(body).toContain("Confirming market data");
  });

  it("a resolved historical-only truth still says historical", () => {
    gateState = {
      truth: { analysis: { level: "historical_only" } }, level: "historical_only", isFull: false, downgraded: true,
      reason: "Only historical candles are available.",
    };
    render(<TimingIntelligenceCard symbol="EURUSD" />);
    expect(screen.getByTestId("timing-intelligence-downgraded").textContent).toMatch(/historical read/);
  });
});

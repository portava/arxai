import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

// The Timing Intelligence freshness line must say which clock it reports:
// generatedAt is when the server recalculated (every poll), not when the
// candles behind the read were observed. The data age comes from the read's
// marketEvidence.lastClosedCandleAt (the close of the last closed bar).

const mockUseGetTimingBrain = vi.fn();
vi.mock("@workspace/api-client-react", () => ({
  useGetTimingBrain: (...args: unknown[]) => mockUseGetTimingBrain(...args),
  getGetTimingBrainQueryKey: () => ["timing-brain"],
}));
vi.mock("@/components/scanner/ScannerReadGate", () => ({ ScannerReadGate: () => null }));
vi.mock("@/hooks/useScannerReadGate", () => ({
  useScannerReadGate: () => ({ truth: null, level: "full", isFull: true, downgraded: false, reason: null }),
}));
vi.mock("@/hooks/useScannerTimeframe", () => ({ useScannerTimeframe: () => ["5m", () => {}] }));
vi.mock("@/hooks/useSymbolTruth", () => ({ useSymbolTruth: () => ({ news: null }) }));
vi.mock("@/lib/assistant-name", () => ({ useAssistantName: () => ({ name: "Ruby" }) }));
vi.mock("@/components/scanner/ChartTimingChip", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/scanner/ChartTimingChip")>()),
  timingTimeframeLabel: (c: string | null | undefined) => (c === "M15" ? "15m" : c ?? null),
  userTimingTimezone: () => "UTC",
}));

import { TimingIntelligenceCard } from "./TimingIntelligenceCard";

function read(over: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    symbol: "EURUSD", timeframe: "M15", generatedAt: new Date(now - 2_000).toISOString(),
    marketEvidence: {
      symbol: "EURUSD", timeframe: "M15", source: "mt5_broker", sourceIdentity: "mt5:1",
      lastClosedCandleAt: new Date(now - 25 * 60_000).toISOString(),
    },
    heatScore: 50, tradeabilityScore: 50, edgeScore: 50, dangerScore: 20, trapProbability: 10, roomToMove: 50,
    buyPressure: 50, sellPressure: 40, pressureBias: "NEUTRAL", timingGrade: "B", entryPermission: "WAIT_FOR_ENTRY",
    heatState: "WARM", moveStage: "EARLY", heatSource: {}, session: { sessionName: "London", isKillZoneActive: false, sessionDescription: "" },
    newsOverlay: {}, broadFlow: {}, bestAction: "WATCH_ONLY", actionReason: "",
    dataQuality: { label: "real", note: "" },
    ...over,
  };
}

function mount(r: Record<string, unknown>) {
  mockUseGetTimingBrain.mockReturnValue({ data: r, isLoading: false, isFetching: false, isError: false, refetch: vi.fn() });
  render(<TimingIntelligenceCard symbol="EURUSD" />);
  return screen.getByTestId("timing-intelligence-quality").textContent ?? "";
}

afterEach(() => cleanup());

describe("TimingIntelligenceCard freshness line", () => {
  it("does not present the recalculation time as the data's age", () => {
    const line = mount(read());
    expect(line).not.toContain("updated 2s ago");
    expect(line).toMatch(/calculated \ds ago/);
    expect(line).toContain("last closed 15m candle ended 25m ago");
  });

  it("does not call the read live data when no current closed candle backs it", () => {
    const line = mount(read({ marketEvidence: null }));
    expect(line).not.toContain("Live data");
    expect(line).toMatch(/no current closed candle/);
  });
});

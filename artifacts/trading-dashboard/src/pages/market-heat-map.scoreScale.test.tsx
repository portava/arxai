// Regression: every timing-brain score is already on a 0–100 scale
// (lib/domain/src/timing-brain/types.ts). The heat map multiplied session
// fakeout risk and heat-source confidence by 100 a second time ("Fakeout
// risk: 5500%", "Primary confidence 7000%").
//
// Values come from the real engines:
//   - sessionKillZoneEngine: LONDON_OPEN fakeoutRisk 55
//   - heatEngine: kill zone active -> session_open primaryConfidence 70
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import type { MarketTimingRead } from "@workspace/api-client-react";

vi.mock("@/hooks/useTradingMode", () => ({ useTradingMode: () => ({}) }));
vi.mock("@/lib/use-chart-symbol", () => ({ useChartSymbol: () => ["EURUSD", () => {}], bareSymbol: (s: string) => s }));
vi.mock("@/lib/assistant-name", () => ({ useAssistantName: () => "Ruby" }));

const { NowTab, SessionCard, TodayTab } = await import("./market-heat-map");

function read(overrides: Partial<MarketTimingRead> = {}): MarketTimingRead {
  return {
    symbol: "EURUSD",
    timeframe: "M15",
    generatedAt: "2026-10-28T07:30:00.000Z",
    heatScore: 62,
    tradeabilityScore: 55,
    edgeScore: 48,
    dangerScore: 35,
    trapProbability: 45,
    roomToMove: 50,
    buyPressure: 50,
    sellPressure: 50,
    pressureBias: "NEUTRAL",
    timingGrade: "B",
    entryPermission: "WAIT_FOR_ENTRY",
    heatState: "WAKE_UP",
    moveStage: "EARLY",
    heatSource: {
      primary: "session_open",
      primaryConfidence: 70,
      backup: "trend_continuation",
      backupConfidence: 40,
      explanation: "London open liquidity",
    },
    session: {
      sessionName: "London",
      killZone: "LONDON_OPEN",
      isKillZoneActive: true,
      utcHour: 7,
      sessionHeatBonus: 25,
      fakeoutRisk: 55,
      tradeabilityBonus: 20,
      bestSymbols: [],
      dangerSymbols: [],
      sessionDescription: "London open",
      userLocalTime: null,
    },
    newsOverlay: {
      phase: "NONE",
      eventName: null,
      minutesUntil: null,
      minutesSince: null,
      eventType: "none",
      surpriseScore: null,
      heatAdjustment: 0,
      blocksTrade: false,
    },
    broadFlow: {
      verdict: "UNAVAILABLE",
      institutionalFlowScore: 0,
      competingCatalyst: false,
      description: "",
      correlatedAssets: [],
      dataQuality: "unavailable",
    },
    bestAction: "WATCH_ONLY",
    actionReason: "",
    dataQuality: {
      label: "partial",
      hasCandleData: true,
      hasQuoteData: true,
      hasNewsData: false,
      hasBroadFlowData: false,
      note: "",
    },
    ...overrides,
  } as MarketTimingRead;
}

afterEach(() => cleanup());

function noPercentAbove100(text: string) {
  for (const m of text.matchAll(/(\d+)%/g)) {
    expect(Number(m[1])).toBeLessThanOrEqual(100);
  }
}

describe("market heat map — fakeout risk and heat-source confidence are 0–100", () => {
  it("Session card prints fakeout risk 55 as 55%", () => {
    const { container } = render(<SessionCard session={read().session} />);
    const text = container.textContent ?? "";
    expect(text).toContain("55%");
    expect(text).not.toContain("5500%");
    noPercentAbove100(text);
  });

  it("Today tab prints fakeout risk 55 as 55%", () => {
    const { container } = render(<TodayTab data={read()} multiData={[]} />);
    const text = container.textContent ?? "";
    expect(text).toContain("Fakeout risk: 55%");
    noPercentAbove100(text);
  });

  it("Now tab heat source prints primary 70% and backup 40%", () => {
    const { container } = render(<NowTab data={read()} isLoading={false} symbol="EURUSD" />);
    const text = container.textContent ?? "";
    expect(text).toContain("Primary confidence70%");
    expect(text).toContain("Backup confidence40%");
    expect(text).not.toContain("7000%");
    noPercentAbove100(text);
  });
});

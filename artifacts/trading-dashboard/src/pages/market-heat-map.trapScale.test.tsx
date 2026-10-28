// Regression (trap probability): every timing-brain score is already on a 0–100 scale
// (lib/domain/src/timing-brain/types.ts). The heat map multiplied trap
// probability by 100 a second time ("Trap prob. 4500%"), and the
// cross-symbol "Trap" badge fired at >= 0.5, i.e. on practically every
// symbol.
//
// Values come from the real engines:
//   - trapRoomEngine: with < 15 candles trapProbability = session fakeoutRisk (45)
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { MarketTimingRead } from "@workspace/api-client-react";

vi.mock("@/hooks/useTradingMode", () => ({ useTradingMode: () => ({}) }));
vi.mock("@/lib/use-chart-symbol", () => ({ useChartSymbol: () => ["EURUSD", () => {}], bareSymbol: (s: string) => s }));
vi.mock("@/lib/assistant-name", () => ({ useAssistantName: () => "Ruby" }));

const { NowTab, DangerWindowsTab, formatScorePct } = await import("./market-heat-map");

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

describe("market heat map — trap probability is 0–100", () => {
  it("Now tab prints trap probability 45 as 45%, not 4500%", () => {
    const { container } = render(<NowTab data={read()} isLoading={false} symbol="EURUSD" />);
    const text = container.textContent ?? "";
    expect(text).toContain("Trap prob.45%");
    expect(text).not.toContain("4500%");
  });

  it("Danger tab prints trap probability as 45% and the Trap badge needs >= 50", () => {
    const results = [
      read({ symbol: "EURUSD", trapProbability: 5, dangerScore: 20 }),
      read({ symbol: "XAUUSD", trapProbability: 72, dangerScore: 80 }),
    ];
    const { container } = render(<DangerWindowsTab data={read()} results={results} />);
    const text = container.textContent ?? "";
    expect(text).toContain("45%");
    expect(text).not.toContain("4500%");
    // Only XAUUSD (72) earns the badge; EURUSD (5) must not.
    expect(screen.getAllByText("Trap")).toHaveLength(1);
    const xau = screen.getByText("XAUUSD").parentElement!;
    expect(xau.textContent).toContain("Trap");
    const eur = screen.getByText("EURUSD").parentElement!;
    expect(eur.textContent).not.toContain("Trap");
  });

  it("formatter never multiplies, clamps, and says unknown plainly", () => {
    expect(formatScorePct(45)).toBe("45%");
    expect(formatScorePct(140)).toBe("100%");
    expect(formatScorePct(null)).toBe("—");
    expect(formatScorePct(Number.NaN)).toBe("—");
  });
});

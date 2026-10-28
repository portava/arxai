// Truth regression tests for the Market Heat Map labels (session cards, kill
// zone clocks, news provider copy, local time, percent scales, unmeasured
// timing reads). Each case renders the real tab component with a timing read
// shaped like the server's and asserts the label describes what is going on.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import type { MarketTimingRead } from "@workspace/api-client-react";
import { BySessionTab } from "./market-heat-map";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

type Session = MarketTimingRead["session"];

function makeRead(over: Partial<MarketTimingRead> = {}, session: Partial<Session> = {}): MarketTimingRead {
  return {
    symbol: "EURUSD",
    timeframe: "M15",
    generatedAt: "2026-10-27T16:30:00.000Z",
    heatScore: 40,
    tradeabilityScore: 60,
    edgeScore: 55,
    dangerScore: 30,
    trapProbability: 45,
    roomToMove: 50,
    buyPressure: 50,
    sellPressure: 50,
    pressureBias: "NEUTRAL",
    timingGrade: "B",
    entryPermission: "GO",
    heatState: "COOL",
    moveStage: "EARLY",
    heatSource: { primary: "session", primaryConfidence: 50, backup: null, backupConfidence: null, explanation: "" },
    session: {
      sessionName: "New York",
      killZone: "OFF_KILLZONE",
      isKillZoneActive: false,
      utcHour: 16.5,
      sessionHeatBonus: 5,
      fakeoutRisk: 40,
      tradeabilityBonus: 3,
      bestSymbols: [],
      dangerSymbols: [],
      sessionDescription: "New York session.",
      userLocalTime: null,
      ...session,
    },
    newsOverlay: {
      phase: "NONE", eventName: null, minutesUntil: null, minutesSince: null,
      eventType: "none", surpriseScore: null, heatAdjustment: 0, blocksTrade: false,
    },
    broadFlow: {
      verdict: "NEUTRAL", institutionalFlowScore: 50, competingCatalyst: false,
      description: "", correlatedAssets: [], dataQuality: "real",
    },
    bestAction: "WAIT_BETTER_TIMING",
    actionReason: "",
    dataQuality: {
      label: "real", hasCandleData: true, hasQuoteData: true, hasNewsData: true,
      hasBroadFlowData: true, note: "",
    },
    ...over,
  } as MarketTimingRead;
}

describe("By Session tab — UTC clock", () => {
  it("prints the read's UTC clock time, never a decimal hour like '16.5:00'", () => {
    render(<BySessionTab data={makeRead()} />);
    expect(screen.queryByText(/16\.5:00/)).toBeNull();
    expect(screen.getByText(/16:30 UTC/)).toBeTruthy();
  });
});

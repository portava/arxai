// Truth regression tests for the Market Heat Map labels (session cards, kill
// zone clocks, news provider copy, local time, percent scales, unmeasured
// timing reads). Each case renders the real tab component with a timing read
// shaped like the server's and asserts the label describes what is going on.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, within, act } from "@testing-library/react";
import type { MarketTimingRead } from "@workspace/api-client-react";
import { BySessionTab, TodayTab, NowTab, NewsHeatTab, SessionCard } from "./market-heat-map";

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

describe("Today tab — session cards", () => {
  const isActive = (name: string) =>
    within(screen.getByTestId(`session-card-${name}`)).queryByText("Active") != null;

  it("London/NY Overlap lights BOTH the London and the New York card", () => {
    render(<TodayTab data={makeRead({}, { sessionName: "London/NY Overlap" })} multiData={[]} />);
    expect(isActive("London")).toBe(true);
    expect(isActive("New York")).toBe(true);
    expect(isActive("Asia")).toBe(false);
  });

  it("Sydney lights the Sydney card", () => {
    render(<TodayTab data={makeRead({}, { sessionName: "Sydney" })} multiData={[]} />);
    expect(isActive("Sydney")).toBe(true);
    expect(isActive("London")).toBe(false);
  });

  it("a session that matches no card says so in plain words", () => {
    render(<TodayTab data={makeRead({}, { sessionName: "24/7 Synthetic" })} multiData={[]} />);
    for (const n of ["Sydney", "Asia", "London", "New York"]) expect(isActive(n)).toBe(false);
    expect(screen.getByTestId("session-no-card").textContent).toContain("24/7 Synthetic");
  });
});

const UNMEASURED_DQ = {
  label: "basic_timing_estimate", hasCandleData: false, hasQuoteData: false,
  hasNewsData: false, hasBroadFlowData: false, note: "",
} as MarketTimingRead["dataQuality"];

describe("Unmeasured timing reads (no candles, no quote)", () => {
  it("Now tab does not show a timing grade for a read built from session constants", () => {
    render(<NowTab data={makeRead({ dataQuality: UNMEASURED_DQ, timingGrade: "F", entryPermission: "STAND_DOWN" })} isLoading={false} symbol="EURUSD" />);
    expect(screen.queryByText(/^Grade /)).toBeNull();
    expect(screen.getByTestId("timing-grade-unmeasured")).toBeTruthy();
  });

  it("Today's Symbol Heat marks an estimate row with its data-quality badge", () => {
    render(<TodayTab data={undefined} multiData={[makeRead({ symbol: "GBPUSD", dataQuality: UNMEASURED_DQ })]} />);
    expect(screen.getByText("Basic timing estimate")).toBeTruthy();
  });
});

describe("News Heat — provider copy", () => {
  it("a connected calendar with no event near is described as connected, not as a missing feed", () => {
    render(<NewsHeatTab data={makeRead()} />);
    expect(screen.getByText("Economic calendar connected")).toBeTruthy();
    expect(screen.queryByText(/No live news feed/)).toBeNull();
    expect(screen.queryByText(/No economic calendar connected/)).toBeNull();
  });

  it("without a calendar the copy says so and does not call the read live", () => {
    const dq = { ...makeRead().dataQuality, hasNewsData: false };
    render(<NewsHeatTab data={makeRead({ dataQuality: dq })} />);
    expect(screen.getByText(/No economic calendar connected — news heat is a schedule-based estimate only/)).toBeTruthy();
    expect(screen.queryByText(/Live news data/)).toBeNull();
  });
});

describe("News Heat — unconfirmed release time", () => {
  it("a pre-event with no known minute count says the release time is not confirmed", () => {
    const newsOverlay = {
      phase: "PRE_EVENT", eventName: "Consumer Price Index", minutesUntil: null, minutesSince: null,
      eventType: "high_impact", surpriseScore: null, heatAdjustment: 15, blocksTrade: false,
    } as MarketTimingRead["newsOverlay"];
    render(<NewsHeatTab data={makeRead({ newsOverlay })} />);
    expect(screen.getByText(/release time not confirmed/)).toBeTruthy();
    expect(screen.queryByText(/min ago/)).toBeNull();
    expect(screen.queryByText("Settled")).toBeNull();
  });
});

describe("Local time", () => {
  const fmt = () => new Date().toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });

  it("'Your local time' is the viewer's current clock, not the cached read's server-formatted time", () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 9, 27, 18, 0, 5), toFake: ["Date", "setInterval", "clearInterval"] });
    const stale = "27/10/2026, 18:00";
    render(<TodayTab data={makeRead({}, { userLocalTime: stale })} multiData={[]} />);
    expect(screen.getByTestId("viewer-local-time").textContent).toBe(`Your local time: ${fmt()}`);
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.getByTestId("viewer-local-time").textContent).toBe(`Your local time: ${fmt()}`);
    expect(screen.getByTestId("viewer-local-time").textContent).not.toContain(stale);
  });

  it("the session card never shows the server's cached userLocalTime", () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 9, 27, 18, 0, 5), toFake: ["Date", "setInterval", "clearInterval"] });
    const stale = "01/01/2020, 00:00";
    render(<SessionCard session={makeRead({}, { userLocalTime: stale }).session} />);
    expect(screen.queryByText(new RegExp(stale))).toBeNull();
    expect(screen.getByTestId("session-card-local-time").textContent).toBe(`Your local time: ${fmt()}`);
  });
});

describe("Percent scales (server scores are already 0-100)", () => {
  it("trap probability, heat-source confidence and fakeout risk are not multiplied by 100 again", () => {
    const read = makeRead({
      trapProbability: 45,
      heatSource: { primary: "session_open", primaryConfidence: 70, backup: "trend_continuation", backupConfidence: 40, explanation: "" },
    }, { fakeoutRisk: 40 });
    const { container } = render(<NowTab data={read} isLoading={false} symbol="EURUSD" />);
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/\d{3,}%/);
    expect(text).toContain("45%");
    expect(text).toContain("70%");
    expect(text).toContain("40%");
  });
});

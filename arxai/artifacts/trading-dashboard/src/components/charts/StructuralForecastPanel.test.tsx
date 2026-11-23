import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StructuralForecastPanel, forecastDirectionRead, routeProgress, ForecastDirectionSummary, trajectoryChartLabel, trajectoryLabel, rangeSentence } from "./StructuralForecastPanel";

const row = { id: "saved-1", issuedAt: 1800000000000, scores: [], forecast: {
  asOf: 1800000000000, origin: { symbol: "V75", provider: "deriv" }, mode: "BASELINE", version: "arx-v6.7-implementation-1",
  gateReason: "INDEPENDENT_GATE_REJECTED", horizons: [{ minutes: 60, probabilities: [.5, .3, .2] }, { minutes: 5, probabilities: [.1, .1, .8] }],
  paths: ["UP_FIRST", "DOWN_FIRST", "NEITHER"].map((scenario, i) => ({ scenario, probability: [.5, .3, .2][i],
    label: "ILLUSTRATIVE_TRAINING_PATH", candles: i === 2 ? [] : [{ openTime: 1800000000000, closeTime: 1800000060000, open: 100, high: 101, low: 99, close: 100.5, isFinal: true }],
    unavailableReason: i === 2 ? "NO_CLASS_MATCHING_TRAINING_PATH" : null })),
} };
const response = (data: unknown, ok = true) => ({ ok, json: async () => data }) as Response;
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe("ARX structural forecast controls", () => {
  it("does no forecast/network work until requested", () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    render(<StructuralForecastPanel symbol="V75" onPaths={vi.fn()} />);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("shows saved scenarios, horizon probabilities and an honest missing class", async () => {
    const onPaths = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response({ forecasts: [] })).mockResolvedValueOnce(response({ saved: true, ...row })));
    render(<StructuralForecastPanel symbol="V75" onPaths={onPaths} />);
    fireEvent.click(screen.getByRole("button", { name: "Forecast 1 hour ahead" }));
    await screen.findByText("50.0%");
    expect(screen.getByText(/Ghost paths are illustrative/)).toBeTruthy();
    expect(screen.getByLabelText(/Neither confirmed.*path unavailable/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/Bullish first \(/));
    await waitFor(() => expect(onPaths.mock.lastCall?.[0].some((p: { scenario: string }) => p.scenario === "UP_FIRST")).toBe(false));
  });
  it("asks for the chosen window and shows a forecast only under its own window", async () => {
    const onPaths = vi.fn();
    const fetch = vi.fn().mockResolvedValueOnce(response({ forecasts: [] })).mockResolvedValueOnce(response({ saved: true, ...row }))
      .mockResolvedValueOnce(response({ forecasts: [] })).mockResolvedValueOnce(response({ saved: false, reason: "UNBROKEN_HISTORY_TOO_SHORT",
        detail: { timeframe: "H4", chartSource: "deriv_public", chartQuality: "clean", chartAiUsable: true, historySource: "deriv_public", closedBars: 900, trainingWindows: 50, trainingWindowsNeeded: 153, lastCloseAgeSeconds: 30 } }, false));
    vi.stubGlobal("fetch", fetch);
    render(<StructuralForecastPanel symbol="V75" onPaths={onPaths} />);
    expect(Array.from((screen.getByLabelText("Forecast window") as HTMLSelectElement).options).map(o => o.textContent))
      .toEqual(["15 minutes", "30 minutes", "1 hour", "4 hours", "8 hours", "12 hours", "24 hours", "2 days", "1 week"]);
    fireEvent.click(screen.getByRole("button", { name: "Forecast 1 hour ahead" }));
    await screen.findByText("50.0%");
    expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual({ symbol: "V75", horizon: "1h" });
    // The one-hour forecast is not presented as a one-week forecast.
    fireEvent.change(screen.getByLabelText("Forecast window"), { target: { value: "1w" } });
    expect(screen.queryByText("50.0%")).toBeNull();
    await waitFor(() => expect(onPaths.mock.lastCall?.[0]).toEqual([]));
    fireEvent.click(screen.getByRole("button", { name: "Forecast 1 week ahead" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/H4 feed.*50 of 153 gap-free training windows/);
    expect(JSON.parse(fetch.mock.calls[3]![1].body)).toEqual({ symbol: "V75", horizon: "1w" });
  });
  it("switches the chart to the requested forecast interval on success", async () => {
    const onShow = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response({ forecasts: [] })).mockResolvedValueOnce(response({ saved: true, ...row, forecast: { ...row.forecast, horizonId: "24h" } })));
    const { rerender } = render(<StructuralForecastPanel symbol="V75" onPaths={vi.fn()} chartTimeframe="M1" onShowOnTimeframe={onShow} />);
    fireEvent.change(screen.getByLabelText("Forecast window"), { target: { value: "24h" } });
    fireEvent.click(screen.getByRole("button", { name: "Forecast 24 hours ahead" }));
    const notice = await screen.findByTestId("forecast-timeframe-mismatch");
    expect(onShow).toHaveBeenCalledTimes(1);
    expect(onShow).toHaveBeenCalledWith("M30");
    expect(notice.textContent).toMatch(/M30 candles and are not drawn on this M1 chart/);
    fireEvent.click(screen.getByRole("button", { name: "Show on M30" }));
    expect(onShow).toHaveBeenCalledWith("M30");
    rerender(<StructuralForecastPanel symbol="V75" onPaths={vi.fn()} chartTimeframe="M30" onShowOnTimeframe={onShow} />);
    expect(screen.queryByTestId("forecast-timeframe-mismatch")).toBeNull();
  });
  it("draws bull, middle and bear paths labeled with their percentages, and shows grades and what it learned", async () => {
    const onPaths = vi.fn();
    const bar = (close: number) => ({ openTime: 1800000000000, closeTime: 1800000060000, open: 100, high: Math.max(100, close), low: Math.min(100, close), close, isFinal: true });
    const trajectories = [["BULL", 75, .012, .58], ["MIDDLE", 50, .001, .5], ["BEAR", 25, -.009, .4]].map(([kind, percentile, endChange, share]) =>
      ({ kind, percentile, label: "ANALOG_PERCENTILE_PATH", candles: [bar(100 * (1 + (endChange as number)))], endChange, share, analogs: 120, sourceEnd: 1 }));
    const forecast = { ...row.forecast, trajectories, directionEdge: false,
      range: { engine: "VOLATILITY", reason: "HISTORY_NOT_RELIABLY_BETTER", tested: 88, historyInside: .477, volatilityInside: .511 }, calibration: { applied: true, reason: "IMPROVED_ON_HELD_OUT_FORECASTS", graded: 42, heldOut: 13, weight: .25, frequencies: [.4, .4, .2], holdoutGain: .012, raw: [.55, .25, .2] } };
    const graded = { ...row, id: "old", issuedAt: 1799990000000, forecast, scores: [{ horizon: 60, outcome: "DOWN_FIRST", brier: .3, baselineBrier: .4, logLoss: .5,
      grade: { gradeVersion: "g", letter: "B", skill: .3, probabilityOfOutcome: .6, actualEndChange: -.004, nearestPath: "MIDDLE", insideRange: true, middlePathError: .001 } }] };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response({ forecasts: [graded] })).mockResolvedValueOnce(response({ saved: true, ...row, forecast })));
    render(<StructuralForecastPanel symbol="V75" onPaths={onPaths} />);
    fireEvent.click(screen.getByRole("button", { name: "Forecast 1 hour ahead" }));
    await screen.findByLabelText("Projected paths");
    await waitFor(() => expect(onPaths.mock.lastCall?.[0].map((p: { id: string }) => p.id)).toEqual(["BULL", "MIDDLE", "BEAR"]));
    const labels = onPaths.mock.lastCall![0].map((p: { label: string }) => p.label);
    // Short labels on the chart; the full sentence stays in the panel's path list.
    // No tested direction edge on this market: the "x% higher" share is not shown.
    expect(labels).toEqual(["Up first 50.0%", "Median", "Down first 30.0%"]);
    expect(screen.getByLabelText("Projected paths").textContent).toContain("Bull +1.20% · top of the range · up-break first 50%");
    expect(screen.getByLabelText("Projected paths").textContent).toContain("Bear −0.90% · bottom of the range · down-break first 30%");
    expect(screen.getByLabelText("Projected paths").textContent).not.toMatch(/ended higher|ended lower/);
    expect(screen.getByTestId("forecast-range-engine").textContent).toBe("Range engine for this market: volatility — sized from recent price swings, because the history range did not score reliably better here. On 88 setups the model did not learn from, the history range held 48% of outcomes and the volatility range 51% (ideal 50%). The analogs have no verified edge for whether the window ends higher or lower. First-break odds are scored separately.");
    // The explanation matches what is drawn and what was learned (audit 2026-11-15).
    expect(screen.getByText(/The paths are not price predictions: .*shaded range from bull to bear is a nominal 50% endpoint interval; actual coverage can differ.*adjusted by what earlier graded forecasts showed/)).toBeTruthy();
    expect(screen.queryByText(/Ghost candles/)).toBeNull();
    expect(screen.getByTestId("forecast-learning").textContent).toMatch(/Learned from 42 independent graded forecasts.*0\.012 Brier better on the 13 newest/);
    const grades = screen.getByTestId("forecast-grades").textContent!;
    expect(grades).toMatch(/Graded 1 hour forecasts: 1/);
    expect(grades).toMatch(/B .*broke down first, gave it 60% · ended −0\.40% · nearest middle path · inside bull–bear range/);
    fireEvent.click(screen.getByLabelText(/^Middle /));
    await waitFor(() => expect(onPaths.mock.lastCall?.[0].map((p: { id: string }) => p.id)).toEqual(["BULL", "BEAR"]));
  });
  it("shows the up/down share only on a market where history beat a coin flip", () => {
    const t = { kind: "BULL", percentile: 75, label: "ANALOG_PERCENTILE_PATH", candles: [], endChange: .012, share: .58, analogs: 120, sourceEnd: 1 } as const;
    expect(trajectoryChartLabel(t as never, true)).toBe("Bull +1.20% · 58% higher");
    expect(trajectoryLabel(t as never, [.5, .3, .2], true)).toBe("Bull +1.20% · 58% of 120 ended higher · up-break first 50%");
    expect(trajectoryChartLabel(t as never)).toBe("Bull +1.20% · range top");
    expect(rangeSentence({ range: { engine: "HISTORY", reason: "HISTORY_RELIABLY_BETTER", tested: 109, historyInside: .24, volatilityInside: .09 }, directionEdge: true } as never))
      .toBe("Range engine for this market: history — the 25th–75th percentile of similar past setups, because it scored reliably better than a volatility range here. On 109 setups the model did not learn from, the history range held 24% of outcomes and the volatility range 9% (ideal 50%). Up/down: the share of similar setups that ended higher beat a coin flip here, so it is shown.");
    expect(rangeSentence({} as never)).toBeNull();
    const vol = (volatility?: string) => rangeSentence({ range: { engine: "VOLATILITY", reason: "HISTORY_NOT_RELIABLY_BETTER", tested: 0, historyInside: null, volatilityInside: null, volatility } } as never);
    expect(vol("HOUR_OF_WEEK")).toContain("sized from how much this market usually moves at these hours of the week and how active it has been today");
    expect(vol("RECENT_120_BARS")).toContain("sized from recent price swings");
    expect(vol()).toContain("sized from recent price swings");
  });
  it("in dynamic mode shows an update over its faint original and grades updates apart from fresh forecasts", async () => {
    const onPaths = vi.fn();
    const bar = (close: number) => ({ openTime: 1800000000000, closeTime: 1800000060000, open: 100, high: Math.max(100, close), low: Math.min(100, close), close, isFinal: true });
    const trajectories = [["BULL", .01], ["MIDDLE", 0], ["BEAR", -.01]].map(([kind, endChange]) =>
      ({ kind, percentile: 50, label: "ANALOG_PERCENTILE_PATH", candles: [bar(100 * (1 + (endChange as number)))], endChange, share: .5, analogs: 40, sourceEnd: 1 }));
    const grade = (letter: string, skill: number) => ({ gradeVersion: "g", letter, skill, probabilityOfOutcome: .5, actualEndChange: 0, nearestPath: "MIDDLE", insideRange: true, middlePathError: 0 });
    const score = (g: ReturnType<typeof grade>) => [{ horizon: 60, outcome: "NEITHER", brier: .3, baselineBrier: .4, logLoss: .5, grade: g }];
    const original = { ...row, id: "original", issuedAt: 1799999400000, forecast: { ...row.forecast, asOf: 1799999400000, trajectories }, scores: score(grade("A", .6)) };
    const oldUpdate = { ...row, id: "old-update", issuedAt: 1799990000000, forecast: { ...row.forecast, trajectories, update: { of: "x", anchorAsOf: 1799989000000, barsIntoWindow: 40 } }, scores: score(grade("B", .3)) };
    const update = { saved: true, ...row, id: "live", forecast: { ...row.forecast, trajectories, update: { of: "original", anchorAsOf: 1799999400000, barsIntoWindow: 10 } } };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response({ forecasts: [original, oldUpdate] })).mockResolvedValueOnce(response(update)));
    render(<StructuralForecastPanel symbol="V75" onPaths={onPaths} />);
    fireEvent.click(screen.getByLabelText("Dynamic forecast"));
    expect((await screen.findByTestId("forecast-update")).textContent).toMatch(/Updated 10 M1 bars into the forecast issued .*faint dashed outline.*not used to learn/);
    await waitFor(() => expect(onPaths.mock.lastCall?.[0].map((p: { id: string; faded?: boolean }) => `${p.id}${p.faded ? ":faded" : ""}`))
      .toEqual(["BULL:faded", "MIDDLE:faded", "BEAR:faded", "BULL", "MIDDLE", "BEAR"]));
    expect(screen.getByTestId("forecast-grade-cohorts").textContent).toBe("Fresh forecasts: 1, average skill 0.60 · Updates mid-window: 1, average skill 0.30 (less time left, so not comparable)");
    expect(screen.getByTestId("forecast-grades").textContent).toMatch(/update \+40 bars/);
  });
  it("renders saved per-close routes and the actual break weights when a live update fails", async () => {
    const onPaths = vi.fn(), onShow = vi.fn(), onRead = vi.fn();
    const candles = row.forecast.paths[0]!.candles;
    const saved = { ...row, forecast: { ...row.forecast, horizons: [{ bars: 60, minutes: 60, probabilities: [.455, .545, 0] }],
      routes: [{ scenario: "UP_FIRST", matches: 12, candles }, { scenario: "DOWN_FIRST", matches: 17, candles }, { scenario: "NEITHER", matches: 1, candles: [] }] } };
    const other = { ...saved, id: "other", issuedAt: saved.issuedAt + 4000, forecast: { ...saved.forecast, horizonId: "1w" } };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response({ forecasts: [other, saved] })).mockResolvedValueOnce(response({ saved: false, reason: "LIVE_CHART_UNAVAILABLE" }, false)));
    render(<StructuralForecastPanel symbol="V75" onPaths={onPaths} onDirectionRead={onRead} chartTimeframe="M15" onShowOnTimeframe={onShow} />);
    fireEvent.click(screen.getByRole("button", { name: "Forecast 1 hour ahead" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Showing the saved forecast/);
    expect(onShow).toHaveBeenCalledWith("M1");
    await waitFor(() => expect(onRead.mock.lastCall?.[0]).toMatchObject({ savedFallback: true, favoriteScenario: "DOWN_FIRST", view: "routes" }));
    expect(onPaths.mock.lastCall?.[0].map((p: {label: string}) => p.label)).toEqual(["Bullish first 45.5%", "Bearish first 54.5%", "Neither confirmed 0.0%"]);
    expect((screen.getByLabelText(/No-break route .*too few for a route/) as HTMLInputElement).disabled).toBe(true);
  });
  it("scores only completed same-source candles against the frozen route", () => {
    const b = row.forecast.paths[0]!.candles[0]!;
    const bar = { openTime: new Date(b.openTime).toISOString(), closeTime: new Date(b.closeTime).toISOString(), close: 101, isComplete: true, isForming: false, source: "deriv" };
    const route = { scenario: "DOWN_FIRST" as const, matches: 20, candles: [b] };
    expect(routeProgress(route, [bar], "deriv", b.closeTime - 1)).toMatchObject({ matched: 0, next: b });
    expect(routeProgress(route, [bar, { ...bar, close: 200, source: "elsewhere" }, { ...bar, close: 300, isForming: true }], "deriv", b.closeTime)).toMatchObject({ matched: 1, mae: .5, flatMae: 1 });
  });
  it("never claims an unsaved forecast was issued", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response({ forecasts: [] })).mockResolvedValueOnce(response({ saved: false, reason: "FORECAST_UNAVAILABLE" }, false)));
    render(<StructuralForecastPanel symbol="V75" onPaths={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Forecast 1 hour ahead" }));
    await screen.findByRole("alert");
    expect(screen.queryByText(/Saved .*forecasts:/)).toBeNull();
  });
  it("reviews memory and performance without issuing another forecast", async () => {
    const fetch = vi.fn().mockResolvedValue(response({ forecasts: [{ ...row, scores: [{ horizon: 60, outcome: "UP_FIRST", brier: .38, baselineBrier: .5, logLoss: .69 }] }] }));
    vi.stubGlobal("fetch", fetch);
    render(<StructuralForecastPanel symbol="V75" onPaths={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Refresh saved forecasts" }));
    await screen.findByLabelText("Selected horizon probabilities");
    await screen.findByText("1 hour resolved: 1");
    expect(screen.getByText("Brier: 0.3800")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Saved forecast"), { target: { value: row.id } });
    await screen.findByText("50.0%");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("grades the displayed odds and excludes displayed ties from directional calls", async () => {
    const saved = (id: string, probabilities: number[], outcome: string, shownBrier?: number) => ({
      ...row, id, forecast: { ...row.forecast, horizons: [{ bars: 60, minutes: 60, probabilities }],
        calibration: { applied: true, graded: 40, heldOut: 12, weight: .25, raw: [.6, .2, .2], holdoutGain: .01 } },
      scores: [{ horizon: 60, outcome, brier: .1, baselineBrier: .4, logLoss: .1, shownBrier }],
    });
    const forecasts = [saved("tied", [.49999, .50001, 0], "DOWN_FIRST"), saved("unique", [.2, .6, .2], "DOWN_FIRST", .24)];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ forecasts })));
    render(<StructuralForecastPanel symbol="V75" onPaths={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Refresh saved forecasts" }));
    await screen.findByText("Direction precision: 100.0% (1)");
    expect(screen.getByText("Direction recall: 50.0%")).toBeTruthy();
    expect(screen.getByText("Brier: 0.3700")).toBeTruthy();
    expect(screen.getByText("Log loss: 0.6020")).toBeTruthy();
  });
  it("clears old instrument paths when the symbol changes", async () => {
    const onPaths = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response({ forecasts: [] })).mockResolvedValueOnce(response({ saved: true, ...row })));
    const view = render(<StructuralForecastPanel symbol="V75" onPaths={onPaths} />);
    fireEvent.click(screen.getByRole("button", { name: "Forecast 1 hour ahead" }));
    await screen.findByText("50.0%");
    view.rerender(<StructuralForecastPanel symbol="V50" onPaths={onPaths} />);
    await waitFor(() => expect(onPaths.mock.lastCall?.[0]).toEqual([]));
    expect(screen.queryByText("50.0%")).toBeNull();
  });
});


describe("chart directional weights", () => {
  const read = (p: [number, number, number]) => forecastDirectionRead({
    ...row.forecast, horizonId: "1h", horizons: [{ minutes: 60, bars: 60, probabilities: p }],
  } as Parameters<typeof forecastDirectionRead>[0]);
  it("shows the saved probabilities, direction and baseline for the selected horizon", () => {
    const direction = read([0.455365, 0.5446349, 0.0000001])!;
    expect(direction.favoredBreak).toBe("down");
    render(<ForecastDirectionSummary read={direction} />);
    expect(screen.getByTestId("forecast-direction").textContent).toMatch(/Bearish break favored.*Up first 45.5%.*Down first 54.5%.*No break <0.1%.*8.9 pt lead.*Historical-frequency baseline/);
  });
  it("can favor neither, show a displayed tie, or withhold malformed weights", () => {
    expect(read([.6,.2,.2])?.favoredBreak).toBe("up");
    expect(read([.2,.2,.6])?.favoredBreak).toBeNull();
    expect(read([.5,.5,0])?.favoredBreak).toBeNull();
    expect(read([.2,.2,.6])?.verdict).toBe("No break favored");
    expect(read([.48002,.47998,.04])?.verdict).toBe("No clear favorite");
    expect(read([.9,.9,0])).toBeNull();
  });
});

it("dynamic Forecast keeps its bar timer when the chart redraws", async () => {
  vi.useFakeTimers();
  const fetch = vi.fn(async (_url: string, init?: RequestInit) =>
    response(init?.method === "POST" ? { saved: true, ...row } : { forecasts: [] }));
  vi.stubGlobal("fetch", fetch);
  try {
    const props = () => ({symbol:"V75",onPaths:vi.fn(),onShowOnTimeframe:vi.fn(),chartTimeframe:"M1"});
    const view=render(<StructuralForecastPanel {...props()} />);
    await act(async () => { fireEvent.click(screen.getByRole("checkbox",{name:"Dynamic forecast"})); });
    for(let i=0;i<15;i++) {
      view.rerender(<StructuralForecastPanel {...props()} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    }
    expect(fetch.mock.calls.filter(([,opts])=>opts?.method === "POST")).toHaveLength(2);
  } finally { vi.useRealTimers(); }
});

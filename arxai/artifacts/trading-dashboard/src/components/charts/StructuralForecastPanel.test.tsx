import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StructuralForecastPanel } from "./StructuralForecastPanel";

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
    expect(screen.getByText(/Ghost candles are illustrative/)).toBeTruthy();
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
    await screen.findByText("1 hour resolved: 1");
    expect(screen.getByText("Brier: 0.3800")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Saved forecast"), { target: { value: row.id } });
    await screen.findByText("50.0%");
    expect(fetch).toHaveBeenCalledTimes(1);
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

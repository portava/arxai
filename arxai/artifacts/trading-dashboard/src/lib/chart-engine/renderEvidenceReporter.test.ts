// The reporter posts the engine's own measurement verbatim (bars, axes,
// drawings, projections) — it never fills in or upgrades a field.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { reportRenderEvidence, __resetRenderEvidenceReporterForTests } from "./renderEvidenceReporter";
import type { ChartEngineAdapter, RenderFidelity } from "./types";

const fidelity: RenderFidelity = {
  displayMode: "heikinAshi", newestBarTime: 900, barsCompared: 3, mismatchedBars: 0, droppedBars: 0,
  priceRoundTripOk: true, timeRoundTripOk: true, visibleBarsRoundTripped: 3,
  drawings: { checked: 2, failed: 1, unplaced: 0, failedIds: ["fib"] },
  projections: [{ previewId: "pv", symbol: "EURUSD", timeframe: "M5", role: "entry", price: 1.1, axisRoundTripOk: true }],
};
const adapterWith = (f: RenderFidelity | null) => ({ measureRenderFidelity: () => f }) as unknown as ChartEngineAdapter;

describe("reportRenderEvidence", () => {
  beforeEach(() => __resetRenderEvidenceReporterForTests());

  it("posts the measurement as measured, bound to the chart's symbol/timeframe/source", () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response("{}")));
    vi.stubGlobal("fetch", fetchMock);
    reportRenderEvidence(adapterWith(fidelity), { symbol: "EURUSD", timeframe: "M5", source: "mt5_broker" }, 1_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/me/chart/render-evidence");
    expect(JSON.parse(String(init.body))).toEqual({ symbol: "EURUSD", timeframe: "M5", source: "mt5_broker", ...fidelity });
  });

  it("posts nothing without a source or a measurement", () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response("{}")));
    vi.stubGlobal("fetch", fetchMock);
    reportRenderEvidence(adapterWith(fidelity), { symbol: "EURUSD", timeframe: "M5", source: null });
    reportRenderEvidence(adapterWith(null), { symbol: "EURUSD", timeframe: "M5", source: "mt5_broker" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CalibratedProbability, calibrationText } from "./CalibratedProbability";
import { CalibrationReliabilityCard, brierVerdict, sourceText, type CalibrationFitView } from "./CalibrationReliabilityCard";

// The UI side of the calibration engine:
//   - a measured probability renders as "62% (N=143)", never without its N;
//   - below the minimum sample it renders "unmeasured (N=12)" and NO "%";
//   - the trader-facing card shows the reliability diagram and the three
//     Brier scores, and says "no measured edge" when there is none;
//   - the scanner card and trade ticket render the calibrated reading.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const fit = (o: Partial<CalibrationFitView> = {}): CalibrationFitView => ({
  fitKey: "strategy:trend_continuation|EURUSD|M15",
  version: 3,
  source: "strategy_replay",
  strategy: "strategy:trend_continuation",
  symbol: "EURUSD",
  timeframe: "M15",
  status: "measured",
  model: "base_rate",
  n: 412,
  baseRate: 0.38,
  brier: 0.2356,
  brierBaseline: 0.2356,
  brierRaw: 0.4637,
  edgeDetected: false,
  reliability: [{ lo: 0.3, hi: 0.4, n: 412, meanPredicted: 0.38, observedRate: 0.379 }],
  rawReliability: [{ lo: 0.7, hi: 0.8, n: 300, meanPredicted: 0.74, observedRate: 0.37 }],
  fittedAt: "2026-11-09T10:00:00.000Z",
  ...o,
});

describe("CalibratedProbability", () => {
  it("renders a measured probability with its N", () => {
    render(<CalibratedProbability calibration={{ probability: 0.6234, status: "measured", n: 143, scope: "exact", edgeDetected: true }} />);
    const el = screen.getByTestId("calibrated-probability");
    expect(el.textContent).toBe("62% (N=143)");
    expect(el.getAttribute("data-calibration-status")).toBe("measured");
    expect(el.getAttribute("title")).toMatch(/143 graded outcomes/);
  });

  it("renders unmeasured with its N and no percent sign", () => {
    render(<CalibratedProbability calibration={{ probability: null, status: "unmeasured", n: 12 }} />);
    const el = screen.getByTestId("calibrated-probability");
    expect(el.textContent).toBe("unmeasured (N=12)");
    expect(el.textContent).not.toMatch(/%/);
  });

  it("a missing reading is unmeasured with N=0", () => {
    expect(calibrationText(undefined)).toBe("unmeasured (N=0)");
  });

  it("labels a borrowed timeframe in the tooltip", () => {
    render(<CalibratedProbability calibration={{ probability: 0.4, status: "measured", n: 90, scope: "timeframe_fallback:H1" }} />);
    expect(screen.getByTestId("calibrated-probability").getAttribute("title")).toMatch(/borrowed from H1/);
  });
});

describe("CalibrationReliabilityCard (trader-facing)", () => {
  function renderCard(body: unknown, ok = true) {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok, status: ok ? 200 : 500, json: async () => body })));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <CalibrationReliabilityCard />
      </QueryClientProvider>,
    );
  }

  it("shows the reliability diagram and served / base-rate / raw Brier scores", async () => {
    renderCard({ ok: true, minSample: 30, measuredCount: 1, edgeCount: 0, lastRefitAt: null, fits: [fit()] });
    await waitFor(() => expect(screen.getByTestId("calibration-reliability-diagram")).toBeTruthy());
    expect(screen.getByTestId("calibration-brier").textContent).toBe("0.236");
    expect(screen.getByTestId("calibration-brier-baseline").textContent).toBe("0.236");
    expect(screen.getByTestId("calibration-brier-raw").textContent).toBe("0.464");
    expect(screen.getByTestId("calibration-fit-n").textContent).toMatch(/N = 412/);
    expect(screen.getByTestId("calibration-verdict").textContent).toMatch(/No measured edge/);
  });

  it("says everything is unmeasured when there are no graded outcomes", async () => {
    renderCard({ ok: true, minSample: 30, measuredCount: 0, edgeCount: 0, lastRefitAt: null, fits: [] });
    await waitFor(() => expect(screen.getByTestId("calibration-empty").textContent).toMatch(/unmeasured \(minimum 30/));
  });

  it("names every source behind N and the real-history fixture it replayed", () => {
    expect(sourceText({ source: "strategy_replay", provenance: null })).toBe("Strategy replay on stored candles");
    expect(
      sourceText({
        source: "historical_replay+strategy_replay",
        provenance: {
          basis: "replay_only",
          liveN: 0,
          replayN: 400,
          components: [{ id: "a", source: "historical_replay", n: 400, fixtureId: "real-history-v1", datasetHash: "fa83f149997cb8f9" }],
        },
      }),
    ).toBe("Replay on committed real price history + Strategy replay on stored candles (real-history-v1 fa83f149)");
  });

  it("verdict wording follows the measured edge", () => {
    expect(brierVerdict(fit({ edgeDetected: true, model: "isotonic", brier: 0.2 }))).toMatch(/Beats the base rate/);
    expect(brierVerdict(fit({ status: "unmeasured", brier: null, n: 7 }))).toBe("Unmeasured: 7 graded outcomes.");
  });
});

describe("scanner surfaces render the calibrated reading", () => {
  const read = (p: string) => readFileSync(resolve(__dirname, "../..", p), "utf8");
  it("scanner result card shows the win probability with N next to the raw score", () => {
    const src = read("pages/market-scanner.tsx");
    expect(src).toMatch(/<CalibratedProbability calibration=\{o\.calibration\}/);
    expect(src).toMatch(/<CalibrationReliabilityCard \/>/);
  });
  it("trade ticket shows the measured win probability", () => {
    const src = read("components/scanner/ScannerTradeModal.tsx");
    expect(src).toMatch(/<CalibratedProbability calibration=\{signal\.calibration\}/);
  });
});

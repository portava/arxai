// Scanner page: per-timeframe coverage + rank-basis text. A fallback is always
// shown as a fallback, budget skips are said plainly, and the raw score is
// never described as a probability.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import {
  TimeframeCoverageStrip, coverageFor, coverageGaps, rankBasisText, UNMEASURED_RANK_TEXT,
  type TimeframeCoverageEntry,
} from "./TimeframeCoverageStrip";

afterEach(() => cleanup());

const cov: TimeframeCoverageEntry[] = [
  { symbol: "EURUSD", timeframe: "M1", status: "signal", readingTimeframe: "M1", fallback: false, label: "M1: own reading" },
  { symbol: "EURUSD", timeframe: "M5", status: "insufficient_data", readingTimeframe: "H1", fallback: true, label: "M5: no signal (insufficient data) — showing the H1 reading (higher-timeframe fallback)" },
  { symbol: "EURUSD", timeframe: "H1", status: "signal", readingTimeframe: "H1", fallback: false, label: "H1: own reading" },
  { symbol: "EURUSD", timeframe: "D1", status: "skipped_budget", readingTimeframe: null, fallback: false, label: "D1: not scanned this cycle (scan budget); no higher timeframe has a signal either" },
];

describe("TimeframeCoverageStrip", () => {
  it("lists the scanned timeframes and every gap, fallbacks flagged", () => {
    render(<TimeframeCoverageStrip coverage={cov} skippedPairs={3} />);
    expect(screen.getByTestId("scanner-timeframe-coverage").textContent).toContain("Timeframes scanned: M1, M5, H1, D1");
    expect(screen.getByTestId("scanner-timeframe-budget-note").textContent).toContain("3 market/timeframe pair(s)");
    const m5 = screen.getByTestId("scanner-coverage-EURUSD-M5");
    expect(m5.getAttribute("data-fallback")).toBe("true");
    expect(m5.textContent).toContain("higher-timeframe fallback");
    expect(screen.getByTestId("scanner-coverage-EURUSD-D1").getAttribute("data-fallback")).toBe("false");
    expect(screen.queryByTestId("scanner-coverage-EURUSD-H1")).toBeNull();
  });

  it("renders nothing without coverage and no budget note when nothing was skipped", () => {
    const { container } = render(<TimeframeCoverageStrip coverage={[]} />);
    expect(container.innerHTML).toBe("");
    render(<TimeframeCoverageStrip coverage={cov.slice(0, 1)} />);
    expect(screen.queryByTestId("scanner-timeframe-budget-note")).toBeNull();
  });

  it("helpers", () => {
    expect(coverageFor(cov, "EURUSD", "M5")?.readingTimeframe).toBe("H1");
    expect(coverageFor(cov, "XAUUSD", "M5")).toBeNull();
    expect(coverageGaps(cov).map((c) => c.timeframe)).toEqual(["M5", "D1"]);
  });
});

describe("rankBasisText", () => {
  it("uses the server label when present, else a tier phrase", () => {
    expect(rankBasisText("calibrated_probability", "ranked by calibrated probability 62% (N=143)")).toContain("N=143");
    expect(rankBasisText("measured_base_rate")).toBe("ranked by measured base rate");
    expect(rankBasisText("unmeasured_raw_order")).toBe(UNMEASURED_RANK_TEXT);
    expect(rankBasisText(undefined)).toBe("unmeasured, ranked by raw score");
    expect(rankBasisText("unmeasured_raw_order")).not.toMatch(/probability|confidence/);
  });
});

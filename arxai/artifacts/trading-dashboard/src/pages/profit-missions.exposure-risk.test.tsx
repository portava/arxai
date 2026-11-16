// Open exposure: open live positions whose risk to the stop is not known must
// not read "Open risk $0.00". The panel says the risk is not known and shows the
// floating loss only as a lower bound.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

vi.mock("@workspace/api-client-react", () => ({
  usePauseProfitMission: () => ({ mutate: vi.fn(), isPending: false }),
  useResumeProfitMission: () => ({ mutate: vi.fn(), isPending: false }),
  useCancelProfitMission: () => ({ mutate: vi.fn(), isPending: false }),
  getListProfitMissionsQueryKey: () => ["profit-missions"],
  getListProfitMissionEventsQueryKey: (id: number) => ["mission-events", id],
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

import { ExposureSummary, MissionImpactPreview } from "./profit-missions";
import { computeMissionImpact } from "@workspace/domain/profit-mission";
import type { MissionImpact } from "@workspace/api-client-react";

afterEach(() => cleanup());

describe("ExposureSummary open risk", () => {
  it("two open trades with unknown risk never read 'Open risk $0.00'", () => {
    render(
      <ExposureSummary
        exposure={{
          openCount: 2,
          totalOpenRisk: 0,
          riskByAssetClass: { forex: 0 },
          countByAssetClass: { forex: 2 },
          riskUnknownCount: 2,
        }}
      />,
    );
    const risk = screen.getByTestId("metric-open-risk");
    expect(risk.textContent).toMatch(/Not known/);
    expect(risk.textContent).not.toMatch(/\$0\.00/);
    expect(screen.getByTestId("list-exposure-classes").textContent).toMatch(/risk not known/);
    expect(screen.getByTestId("list-exposure-classes").textContent).not.toMatch(/\$0\.00/);
    expect(screen.getByTestId("exposure-risk-unknown").textContent).toMatch(/not known for 2 of 2/);
  });

  it("no open trades still reads $0.00", () => {
    render(
      <ExposureSummary
        exposure={{ openCount: 0, totalOpenRisk: 0, riskByAssetClass: {}, countByAssetClass: {}, riskUnknownCount: 0 }}
      />,
    );
    expect(screen.getByTestId("metric-open-risk").textContent).toMatch(/\$0\.00/);
    expect(screen.queryByTestId("exposure-risk-unknown")).toBeNull();
  });
});

describe("MissionImpactPreview truth", () => {
  const impact = computeMissionImpact({
    math: { startingAmount: 1000, targetAmount: 1300, currentValue: 1000,
      timeframeStartMs: 0, timeframeEndMs: 7 * 86_400_000, nowMs: 0 },
    riskAmount: 50, expectedR: 2,
  });

  it("shows conditional values and money per day, with expected return unavailable", () => {
    render(<MissionImpactPreview impact={impact} />);
    const preview = screen.getByTestId("mission-impact-preview");
    expect(preview.textContent).toMatch(/Expected return unavailable/);
    expect(screen.queryByTestId("impact-row-expected")).toBeNull();
    expect(screen.getByTestId("impact-row-win").textContent).toContain("$28.57/day");
    expect(screen.getByTestId("impact-row-loss").textContent).toContain("$50.00/day");
    expect(preview.textContent).not.toMatch(/%\/day/);
  });

  it("withholds fabricated probability and summary from cached legacy API responses", () => {
    const legacy: MissionImpact = { ...impact, winProbability: 0.9,
      expected: { ...impact.win, label: "expected", profitDelta: 85 },
      summary: "Expected case at a 90% win-rate estimate: $85." };
    render(<MissionImpactPreview impact={legacy} />);
    expect(screen.getByTestId("mission-impact-preview").textContent).toMatch(/Expected return unavailable/);
    expect(screen.getByTestId("mission-impact-preview").textContent).not.toMatch(/90%|\$85/);
    expect(screen.queryByTestId("impact-row-expected")).toBeNull();
    expect(screen.getByTestId("impact-row-win").textContent).toMatch(/If target hits/);
  });

  it("does not display corrupt stored conditional amounts", () => {
    render(<MissionImpactPreview impact={{ ...impact, win: { ...impact.win, resultingValue: 9999 } }} />);
    expect(screen.getByTestId("mission-impact-unavailable").textContent).toBe("Mission impact unavailable.");
    expect(screen.queryByTestId("mission-impact-preview")).toBeNull();
  });
});

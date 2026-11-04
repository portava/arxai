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

import { ExposureSummary } from "./profit-missions";

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

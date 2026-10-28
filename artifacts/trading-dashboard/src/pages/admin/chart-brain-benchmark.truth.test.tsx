import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

type HookResult = {
  data: unknown;
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  refetch: () => void;
};
let hook: HookResult;

vi.mock("@workspace/api-client-react", () => ({
  useGetAdminChartBenchmark: () => hook,
  getGetAdminChartBenchmarkQueryKey: () => ["chart-benchmark"],
}));
vi.mock("@/components/admin/AdminDiagnosticsGate", () => ({
  AdminDiagnosticsGate: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import ChartBrainBenchmarkPage from "./chart-brain-benchmark";

afterEach(() => cleanup());

function benchmark(over: Record<string, unknown> = {}) {
  return {
    generatedAt: "2026-10-28T10:00:00.000Z",
    windowDays: 90,
    totalReceipts: 2000,
    totalOutcomes: 0,
    totalReviews: 0,
    totalTraces: 0,
    scores: [],
    trend: [],
    weakAreas: [],
    recentFailedReads: [],
    recentSuccessfulNoTrades: [],
    warnings: [],
    ...over,
  };
}

describe("Chart Brain Benchmark: load failure and coverage", () => {
  it("a failed load shows 'Could not load benchmark' and no evidence totals", () => {
    hook = { data: undefined, isLoading: false, isFetching: false, isError: true, refetch: () => undefined };
    render(<ChartBrainBenchmarkPage />);
    expect(screen.getByText("Could not load benchmark")).toBeTruthy();
    expect(screen.queryByText("Evidence base")).toBeNull();
  });

  it("a capped-read warning is shown under a heading that covers coverage, not only speed and feed", () => {
    const w =
      "This 90-day window holds more than 2000 receipts; only the newest 2000 were read, so the Receipts total and every score cover those 2000 only.";
    hook = {
      data: { benchmark: benchmark({ warnings: [w] }) },
      isLoading: false,
      isFetching: false,
      isError: false,
      refetch: () => undefined,
    };
    render(<ChartBrainBenchmarkPage />);
    expect(screen.getByText("Coverage, speed & feed warnings")).toBeTruthy();
    expect(screen.getByText(w)).toBeTruthy();
  });
});

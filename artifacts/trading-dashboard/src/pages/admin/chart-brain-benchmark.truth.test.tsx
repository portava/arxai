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

describe("Chart Brain Benchmark: a null score shows why it has none", () => {
  it("a not-measured dimension shows its reason, not a generic 'Insufficient data'", () => {
    const note =
      "Not measured: Ruby's explanations are not graded. Every read stores a headline and a what-would-change line, so their presence says nothing about quality.";
    hook = {
      data: {
        benchmark: benchmark({
          scores: [
            { key: "ruby_explanation_quality", label: "Ruby Explanation Quality", score: null, sampleSize: 0, note },
            { key: "reliability", label: "Reliability", score: null, sampleSize: 2, note: "Insufficient data (need ≥3, have 2)." },
            { key: "timing", label: "Timing", score: 80, sampleSize: 5, note: "4/5 trade reads at a real trigger/entry stage." },
          ],
        }),
      },
      isLoading: false,
      isFetching: false,
      isError: false,
      refetch: () => undefined,
    };
    render(<ChartBrainBenchmarkPage />);
    expect(screen.getByText(note)).toBeTruthy();
    expect(screen.getByText("Insufficient data (need ≥3, have 2).")).toBeTruthy();
    expect(screen.getByText("4/5 trade reads at a real trigger/entry stage.")).toBeTruthy();
    expect(screen.queryByText("Insufficient data")).toBeNull();
  });
});

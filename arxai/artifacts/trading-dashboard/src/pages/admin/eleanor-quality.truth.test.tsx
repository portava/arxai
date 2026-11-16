// Eleanor Quality admin page: a rate with nothing to rate shows "—", not 0.0%.
//
// The API returned winRate / explanationAccuracy / bucket winRate as 0 when
// there were no graded rows, so the page showed "Win rate 0.0%" while the
// investor card on the same page showed "Win rate —". The server now returns
// null for an empty denominator; the page must render that as "—".

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";

const state: { metrics: Record<string, unknown> } = { metrics: {} };

vi.mock("@/components/admin/AdminDiagnosticsGate", () => ({
  AdminDiagnosticsGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/lib/assistant-name", () => ({ useAssistantName: () => ({ name: "Eleanor" }) }));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock("@workspace/api-client-react", () => {
  const idle = { data: undefined, isLoading: false, isError: false };
  return {
    useGetAdminEleanorQualityMetrics: () => ({ data: { ok: true, metrics: state.metrics }, isLoading: false, isError: false }),
    useGetAdminEleanorMissedOpportunities: () => idle,
    useGetAdminEleanorThresholds: () => idle,
    useUpdateAdminEleanorThresholds: () => ({ mutate: vi.fn(), isPending: false }),
    useGetAdminEleanorInvestorSummary: () => idle,
  };
});

const { default: AdminEleanorQualityPage } = await import("./eleanor-quality");

function bucket(label: string) {
  return { bucket: label, total: 0, wins: 0, losses: 0, winRate: null };
}
function emptyMetrics(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    totals: { tracked: 0, resolved: 0, pending: 0, unresolved: 0, graded: 0 },
    rates: { winRate: null, tpRate: null, slRate: null, lateRate: null },
    timing: { EARLY: 0, ON_TIME: 0, LATE: 0, UNKNOWN: 0 },
    averages: { slippage: null, startDrawdown: null, mfe: null, mae: null },
    bestSymbols: [], worstSymbols: [], bestSessions: [], worstSessions: [],
    newsFailures: 0, executionFailures: 0, explanationAccuracy: null,
    ignoredWarnings: 0, avoidedBadTrades: 0, missedOpportunities: 0,
    confidenceVsOutcome: [bucket("0-60"), bucket("60-75"), bucket("75-90"), bucket("90-100")],
    edgeVsOutcome: [bucket("0-50"), bucket("50-70"), bucket("70-85"), bucket("85-100")],
    ...extra,
  };
}

afterEach(() => cleanup());

describe("Eleanor Quality metrics — unmeasured rates", () => {
  it("shows — for every rate with nothing to rate, never 0.0%", () => {
    state.metrics = emptyMetrics();
    render(<AdminEleanorQualityPage />);
    for (const id of ["stat-win-rate", "stat-tp-rate", "stat-sl-rate", "stat-late-rate", "stat-explanation-accuracy"]) {
      const card = screen.getByTestId(id);
      expect(card.textContent).toContain("—");
      expect(card.textContent).not.toContain("0.0%");
    }
    expect(document.body.textContent).not.toContain("0.0%");
  });

  it("a measured 0% still shows 0.0%", () => {
    state.metrics = emptyMetrics({
      totals: { tracked: 1, resolved: 1, pending: 0, unresolved: 0, graded: 1 },
      rates: { winRate: 0, tpRate: null, slRate: null, lateRate: null },
    });
    render(<AdminEleanorQualityPage />);
    expect(within(screen.getByTestId("stat-win-rate")).getByText("0.0%")).toBeTruthy();
  });
});

describe("Eleanor Quality metrics — pending vs unresolved, best vs worst", () => {
  it("Pending (awaiting evidence) and Unresolved are separate cards", () => {
    state.metrics = emptyMetrics({
      totals: { tracked: 4, resolved: 1, pending: 1, unresolved: 2, graded: 1 },
    });
    render(<AdminEleanorQualityPage />);
    expect(screen.getByTestId("stat-pending").textContent).toContain("1");
    const unresolved = screen.getByTestId("stat-unresolved");
    expect(unresolved.textContent).toContain("2");
    expect(unresolved.textContent).not.toMatch(/awaiting/i);
  });

  it("an empty Worst list with graded signals does not say 'No graded signals yet'", () => {
    const stat = { key: "EURUSD", graded: 3, wins: 2, winRate: 0.667, avgPnlR: 0.5 };
    state.metrics = emptyMetrics({
      totals: { tracked: 3, resolved: 3, pending: 0, unresolved: 0, graded: 3 },
      rates: { winRate: 0.667, tpRate: null, slRate: null, lateRate: null },
      bestSymbols: [stat], bestSessions: [{ ...stat, key: "london" }],
    });
    render(<AdminEleanorQualityPage />);
    const worst = screen.getByTestId("rank-worst-symbols");
    expect(worst.textContent).not.toMatch(/No graded signals yet/);
    expect(worst.textContent).toMatch(/no graded symbol has a lower win rate/i);
    const worstSessions = screen.getByTestId("rank-worst-sessions");
    expect(worstSessions.textContent).toMatch(/no graded session has a lower win rate/i);
  });

  // Two symbols tied at 100% leave Worst empty with one key under Best. The
  // page cannot tell that apart from "only one graded symbol", so it must not
  // claim there is only one — it says what is true in both cases.
  it("an empty Worst list never claims there is only one graded symbol or session", () => {
    const stat = { key: "AAA", graded: 1, wins: 1, winRate: 1, avgPnlR: 1.5 };
    state.metrics = emptyMetrics({
      totals: { tracked: 2, resolved: 2, pending: 0, unresolved: 0, graded: 2 },
      rates: { winRate: 1, tpRate: null, slRate: null, lateRate: null },
      bestSymbols: [stat], bestSessions: [{ ...stat, key: "london" }],
    });
    render(<AdminEleanorQualityPage />);
    expect(screen.getByTestId("rank-worst-symbols").textContent).not.toMatch(/only one graded/i);
    expect(screen.getByTestId("rank-worst-sessions").textContent).not.toMatch(/only one graded/i);
  });
});

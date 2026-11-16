// CS5: the Smart Chart "Decision receipts" panel lists the trader's own chart
// decisions, records an outcome through the append-only route, finds similar
// past setups and shows behavior cautions — and says when a request failed
// instead of showing an empty history.
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const recordMutate = vi.fn();
const similarMutate = vi.fn();
const state = {
  list: { data: undefined as unknown, isLoading: false, isError: false },
  detail: { data: undefined as unknown, isLoading: false, isError: false },
  similar: { data: undefined as unknown, isPending: false, isError: false },
  behavior: { data: undefined as unknown },
};

vi.mock("@workspace/api-client-react", async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    useGetMeChartDecisionReceipts: () => state.list,
    useGetMeChartDecisionReceipt: () => state.detail,
    usePostMeChartDecisionReceiptOutcome: () => ({ mutate: recordMutate, isPending: false, isError: false }),
    usePostMeChartSimilarSetups: () => ({ ...state.similar, mutate: similarMutate }),
    useGetMeChartBehaviorProtection: () => state.behavior,
  };
});

import { ChartDecisionReceiptsPanel } from "./ChartDecisionReceiptsPanel";

const RECEIPT = {
  receiptId: "r-1", symbol: "EURUSD", timeframe: "M15", source: "chart_read", direction: "BUY",
  qualityLabel: "Good", vetoed: false, agentConflict: false, fingerprint: {}, createdAt: "2026-11-04T10:30:00.000Z",
  marketSentence: "Trend up, pullback holding.",
};

function renderPanel(tf = "M15") {
  const qc = new QueryClient();
  render(
    <QueryClientProvider client={qc}>
      <ChartDecisionReceiptsPanel symbol="EURUSD" timeframe={tf} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  recordMutate.mockReset();
  similarMutate.mockReset();
  state.list = { data: { receipts: [RECEIPT] }, isLoading: false, isError: false };
  state.detail = { data: { receipt: RECEIPT, outcomes: [] }, isLoading: false, isError: false };
  state.similar = { data: undefined, isPending: false, isError: false };
  state.behavior = { data: undefined };
});
afterEach(() => cleanup());

describe("ChartDecisionReceiptsPanel", () => {
  it("lists receipts and records an outcome through the append-only route", () => {
    renderPanel();
    expect(screen.getAllByTestId("chart-receipt-row")).toHaveLength(1);
    fireEvent.click(screen.getByTestId("chart-receipt-toggle"));
    expect(screen.getByTestId("chart-receipt-no-outcome")).toBeTruthy();
    fireEvent.click(screen.getByTestId("chart-receipt-record-WIN"));
    expect(recordMutate).toHaveBeenCalledWith({
      receiptId: "r-1",
      data: { kind: "OUTCOME", outcome: "WIN", plQuality: "UNKNOWN" },
    });
  });

  it("shows the newest recorded outcome", () => {
    state.detail = {
      data: { receipt: RECEIPT, outcomes: [
        { id: 2, receiptRef: "r-1", kind: "OUTCOME", outcome: "LOSS", createdAt: "2026-11-04T11:00:00.000Z" },
        { id: 1, receiptRef: "r-1", kind: "OUTCOME", outcome: "WIN", createdAt: "2026-11-04T10:45:00.000Z" },
      ] },
      isLoading: false, isError: false,
    };
    renderPanel();
    fireEvent.click(screen.getByTestId("chart-receipt-toggle"));
    expect(screen.getByTestId("chart-receipt-outcome").textContent).toContain("Loss");
  });

  it("says loading failed instead of showing an empty history", () => {
    state.list = { data: undefined, isLoading: false, isError: true };
    renderPanel();
    expect(screen.getByTestId("chart-receipts-error")).toBeTruthy();
    expect(screen.queryByTestId("chart-receipts-empty")).toBeNull();
  });

  it("finds similar setups for the chart and shows their outcomes", () => {
    state.similar = {
      data: { result: { summary: "2 similar setups; 1 has a recorded outcome.", matches: [
        { receiptId: "r-0", symbol: "EURUSD", timeframe: "M15", direction: "BUY", similarity: 0.82, createdAt: "2026-11-01T09:00:00.000Z", outcome: "WIN" },
      ] } },
      isPending: false, isError: false,
    };
    renderPanel();
    fireEvent.click(screen.getByTestId("chart-similar-setups-find"));
    expect(similarMutate).toHaveBeenCalledWith({ data: { symbol: "EURUSD", timeframe: "M15" } });
    const res = screen.getByTestId("chart-similar-result");
    expect(res.textContent).toContain("82% similar");
    expect(res.textContent).toContain("Win");
  });

  it("disables similar setups on a timeframe the route does not accept", () => {
    renderPanel("H2");
    expect((screen.getByTestId("chart-similar-setups-find") as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows behavior-protection cautions only when there are signals", () => {
    state.behavior = { data: { protection: { applicable: true, hasSignals: true, summary: "A couple of patterns worth a look.", windowHours: 24, generatedAt: "", signals: [
      { key: "overtrading", severity: "caution", title: "Busy session", detail: "22 trades in 24h.", evidence: {} },
    ] } } };
    renderPanel();
    expect(screen.getByTestId("chart-behavior-protection").textContent).toContain("Busy session");
  });
});

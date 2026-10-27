import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import type { MeOpportunityMapResp } from "@workspace/api-client-react";
const state = vi.hoisted(() => ({ actor: 1 as number | null, reads: [] as { params: any; signal: AbortSignal; resolve: (value: any) => void; reject: (reason: any) => void }[] }));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: state.actor ? { id: state.actor } : null }) }));
vi.mock("@/hooks/useSymbolTruth", () => ({ useSymbolTruth: () => ({ scannerTruth: null }) }));
vi.mock("@/hooks/useScannerTimeframe", () => ({ useScannerTimeframe: () => ["5m", () => {}], loadScannerTimeframe: () => "5m" }));
vi.mock("@/lib/assistant-name", () => ({ useAssistantName: () => ({ name: "Ruby" }) }));
vi.mock("@workspace/api-client-react", async () => {
  const { useQuery } = await import("@tanstack/react-query");
  return {
    getGetMeOpportunityMapQueryKey: (params: unknown) => ["/api/me/opportunity-map", params],
    useGetMeOpportunityMap: (params: any, options: any) => useQuery({ ...options.query,
      queryFn: ({ signal }) => new Promise((resolve, reject) => state.reads.push({ params, signal, resolve, reject })), retry: false }),
    getGetWatchlistsQueryKey: () => ["watchlists"], useGetWatchlists: () => ({ data: [], isError: false }),
  };
});
import { BroadScanOpportunityMap } from "./BroadScanOpportunityMap";
function payload(selectedSymbol: string | null = null, universe = "all") {
  const rows = ["EURUSD", "GBPUSD"].map(symbol => ({ symbol, displayName: symbol, direction: "BUY", recommendedAction: "BUY",
    setupType: "Fixture", edgeScore: 70, entryQuality: 70, executionQuality: 80, newsRisk: "none", hasLiveData: true,
    isLate: false, reason: "Fixture", category: "READY_NOW", kind: "MOMENTUM", bestAction: "Fixture", stageLabel: "Fixture" }));
  return { universe, timeframe: "M5", generatedAt: new Date().toISOString(), universeCount: 2,
    map: { rows, categories: { READY_NOW: rows }, best: { bestScalp: rows[0] }, scannedCount: 2, liveCount: 2 },
    bestVsSelected: { selectedSymbol, selectedEdge: null, best: null, message: selectedSymbol ? `Comparison for ${selectedSymbol}` : null },
    skippedSymbols: [], dataNote: null } as unknown as MeOpportunityMapResp;
}
let client: QueryClient;
function Wrapper({ group = "all" }: { group?: "all" | "forex" }) {
  const [selected, select] = useState<string | null>(null);
  return <QueryClientProvider client={client}><BroadScanOpportunityMap marketGroup={group} selectedSymbol={selected} onPick={select} /></QueryClientProvider>;
}
async function settle(index: number, value = payload()) {
  await act(async () => state.reads[index].resolve(value));
  await waitFor(() => expect(screen.getByTestId("opportunity-row-EURUSD")).toBeTruthy());
}
beforeEach(() => { state.actor = 1; state.reads = []; client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); });
afterEach(() => { cleanup(); client.clear(); });
describe("real query observer scanner continuity", () => {
  it("keeps the exact mounted rows through rapid selection, aborts obsolete read and ignores its late result", async () => {
    render(<Wrapper />); await settle(0);
    const euro = screen.getByTestId("opportunity-row-EURUSD"), pound = screen.getByTestId("opportunity-row-GBPUSD");
    fireEvent.click(euro);
    expect(screen.getByTestId("opportunity-row-EURUSD")).toBe(euro);
    expect(euro.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("opportunity-map-updating")).toBeTruthy();
    fireEvent.click(pound);
    expect(screen.getByTestId("opportunity-row-GBPUSD")).toBe(pound);
    expect(pound.getAttribute("aria-pressed")).toBe("true");
    expect(state.reads[1].signal.aborted).toBe(true);
    await settle(2, payload("GBPUSD"));
    await act(async () => state.reads[1].resolve(payload("EURUSD")));
    expect(screen.getByText("Comparison for GBPUSD")).toBeTruthy();
    expect(screen.queryByText("Comparison for EURUSD")).toBeNull();
  });
  it("withholds the previous selected comparison immediately while keeping rows", async () => {
    render(<Wrapper />); await settle(0);
    fireEvent.click(screen.getByTestId("opportunity-row-EURUSD")); await settle(1, payload("EURUSD"));
    fireEvent.click(screen.getByTestId("opportunity-row-GBPUSD"));
    expect(screen.queryByText("Comparison for EURUSD")).toBeNull();
    expect(screen.getByTestId("opportunity-row-EURUSD")).toBeTruthy();
  });
  it("does not carry rows into another universe", async () => {
    const view = render(<Wrapper />); await settle(0);
    view.rerender(<Wrapper group="forex" />);
    expect(screen.queryByTestId("opportunity-row-EURUSD")).toBeNull();
  });
  it.each([2, null])("does not carry rows across account change to %s", async actor => {
    const view = render(<Wrapper />); await settle(0);
    state.actor = actor; view.rerender(<Wrapper />);
    expect(screen.queryByTestId("opportunity-row-EURUSD")).toBeNull();
  });
  it("never refreshes an expired original timestamp to keep the placeholder actionable", async () => {
    render(<Wrapper />); const old = payload(); old.generatedAt = new Date(Date.now() - 31_000).toISOString(); await settle(0, old);
    fireEvent.click(screen.getByTestId("opportunity-row-EURUSD"));
    expect(screen.getByTestId("opportunity-map-expired")).toBeTruthy();
    expect(screen.queryByTestId("opportunity-row-direction-EURUSD")).toBeNull();
    expect(screen.queryByTestId("opportunity-map-best-picks")).toBeNull();
  });
  it("failed replacement read removes actionable rows", async () => {
    render(<Wrapper />); await settle(0); fireEvent.click(screen.getByTestId("opportunity-row-EURUSD"));
    await act(async () => state.reads[1].reject(new Error("offline")));
    await waitFor(() => expect(screen.getByTestId("opportunity-map-err")).toBeTruthy());
    expect(screen.queryByTestId("opportunity-row-direction-EURUSD")).toBeNull();
  });
});

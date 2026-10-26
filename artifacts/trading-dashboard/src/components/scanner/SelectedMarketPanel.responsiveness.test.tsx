import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setChartSymbol } from "@/lib/use-chart-symbol";

vi.mock("@/hooks/useScannerTruth", () => ({ useScannerTruth: () => ({ truth: null }) }));
vi.mock("@/hooks/useScannerTimeframe", () => ({ useScannerTimeframe: () => ["5m", vi.fn()] }));
vi.mock("@/lib/assistant-name", () => ({ useAssistantName: () => ({ name: "Ruby" }) }));
vi.mock("@/components/live/TradabilityBadge", () => ({ TradabilityBadge: () => null }));
vi.mock("@/components/scanner/SymbolExplorer", () => ({
  SymbolExplorer: ({ onSelect }: { onSelect: (symbol: string) => void }) => <>
    <button onClick={() => onSelect("EURUSD")}>Pick EURUSD</button>
    <button onClick={() => onSelect("GBPUSD")}>Pick GBPUSD</button>
  </>,
}));
vi.mock("@/components/live/LiveTradeTicket", () => ({
  LiveTradeTicket: ({ open, defaultSymbol }: { open: boolean; defaultSymbol: string }) => open ? <div data-testid="ticket">{defaultSymbol}</div> : null,
}));
import { SelectedMarketPanel } from "./SelectedMarketPanel";

let client: QueryClient;
const calls: Array<{ symbol: string; refresh: boolean; signal: AbortSignal; resolve: (response: Response) => void }> = [];
function snapshot(symbol: string) {
  return { ok: true, symbol, symbolRaw: symbol, timeframe: "M5",
    highlights: { bias: "WAIT", confidenceLabel: "Low", confidenceScore: 20, volatilityLabel: "Calm", trendState: "neutral", entryZone: null, suggestedStop: null, suggestedTakeProfit: null, riskRewardRatio: 0, riskWarnings: [] },
    explanation: { hedge: "Awaiting a verified setup.", why: "No confirmed setup.", whyItMatters: "Wait.", risk: "Unknown.", invalidation: "Unknown.", cautions: [], disclaimer: "Decision support only." },
    upcomingEvents: [], newsRisk: { riskLevel: "none", blockTrading: false, summary: "" },
    dataSource: "LIVE_FEED", dataState: "UNAVAILABLE", dataAsOf: "2026-10-26T12:00:00.000Z", generatedAt: "2026-10-26T12:00:01.000Z", levelsWithheld: true, cacheHit: false,
  };
}
async function complete(index: number) {
  await act(async () => calls[index].resolve(new Response(JSON.stringify(snapshot(calls[index].symbol)))));
}
beforeEach(() => {
  calls.length = 0; localStorage.clear(); setChartSymbol("EURUSD");
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 60_000 } } });
  client.setQueryData(["me"], { id: 7 });
  vi.stubGlobal("fetch", vi.fn((url: string, init: RequestInit) => {
    if (String(url).includes("/deriv/status")) return Promise.resolve(new Response(JSON.stringify({ configured: false })));
    const params = new URL(String(url), "http://offline.test").searchParams;
    // Intentionally ignore abort here: an already-arriving obsolete response
    // must still never publish into the current selection.
    return new Promise<Response>((resolve) => calls.push({ symbol: params.get("symbol")!, refresh: params.has("refresh"), signal: init.signal as AbortSignal, resolve }));
  }));
});
afterEach(() => { cleanup(); client.clear(); vi.unstubAllGlobals(); });
function mount() { return render(<QueryClientProvider client={client}><SelectedMarketPanel /></QueryClientProvider>); }

describe("selected-market interaction responsiveness", () => {
  it("updates the symbol label immediately while a new read is unresolved; warm return needs no request", async () => {
    mount(); await complete(0); await screen.findByTestId("btn-open-ticket-buy");
    fireEvent.click(screen.getByTestId("btn-open-ticket-buy")); expect(screen.getByTestId("ticket").textContent).toBe("EURUSD");
    fireEvent.click(screen.getByText("Pick GBPUSD"));
    expect(screen.getByTestId("badge-active-symbol").textContent).toBe("GBPUSD");
    expect(screen.queryByTestId("ticket")).toBeNull();
    expect(screen.queryByTestId("btn-open-ticket-buy")).toBeNull();
    expect(calls).toHaveLength(2);
    fireEvent.click(screen.getByText("Pick EURUSD"));
    expect(screen.getByTestId("badge-active-symbol").textContent).toBe("EURUSD");
    expect(screen.getByTestId("btn-open-ticket-buy")).toBeTruthy();
    expect(screen.queryByTestId("ticket")).toBeNull();
    expect(calls[1].signal.aborted).toBe(true);
    await complete(1);
    expect(screen.getByTestId("badge-active-symbol").textContent).toBe("EURUSD");
    expect(calls).toHaveLength(2);
  });

  it("manual refresh sends one request and cannot bleed its late response into another market", async () => {
    mount(); await complete(0); await screen.findByTestId("btn-open-ticket-buy");
    fireEvent.click(screen.getByTestId("btn-refresh-symbol"));
    await waitFor(() => expect(calls).toHaveLength(2)); expect(calls[1].refresh).toBe(true);
    fireEvent.click(screen.getByText("Pick GBPUSD"));
    expect(calls[1].signal.aborted).toBe(true);
    await complete(2); await screen.findByTestId("btn-open-ticket-buy"); await complete(1);
    expect(screen.getByTestId("badge-active-symbol").textContent).toBe("GBPUSD");
    fireEvent.click(screen.getByTestId("btn-open-ticket-buy"));
    expect(screen.getByTestId("ticket").textContent).toBe("GBPUSD"); expect(calls).toHaveLength(3);
  });

  it("an account switch clears the previous user's read and open ticket", async () => {
    mount(); await complete(0); await screen.findByTestId("btn-open-ticket-buy");
    fireEvent.click(screen.getByTestId("btn-open-ticket-buy"));
    await act(async () => client.setQueryData(["me"], { id: 8 }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(screen.queryByTestId("ticket")).toBeNull(); expect(screen.queryByTestId("btn-open-ticket-buy")).toBeNull();
    await complete(1); await screen.findByTestId("btn-open-ticket-buy");
    expect(screen.queryByTestId("ticket")).toBeNull();
  });
});

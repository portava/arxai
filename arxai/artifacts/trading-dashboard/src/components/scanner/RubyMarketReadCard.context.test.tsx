import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RubyMarketReadCard } from "./RubyMarketReadCard";
import { useScannerTimeframe } from "@/hooks/useScannerTimeframe";
import { useScannerTruth } from "@/hooks/useScannerTruth";

vi.mock("@/hooks/useTradingMode", () => ({ useTradingMode: () => ({ isLoading: false, envelope: null }) }));
vi.mock("@/lib/assistant-name", () => ({ useAssistantName: () => ({ name: "Ruby" }) }));

let client: QueryClient;
const requests: Array<{ url: URL; signal: AbortSignal; resolve: (response: Response) => void }> = [];
beforeEach(() => {
  localStorage.clear(); localStorage.setItem("scanner.chart.timeframe", "15m"); requests.length = 0;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["me"], { id: 7 });
  vi.stubGlobal("fetch", vi.fn((url: string, init: RequestInit) => new Promise<Response>((resolve) => {
    requests.push({ url: new URL(String(url), "http://offline.test"), signal: init.signal as AbortSignal, resolve });
  })));
});
afterEach(() => { cleanup(); client.clear(); vi.unstubAllGlobals(); });

function HeaderObserver({ symbol }: { symbol: string }) {
  const [timeframe] = useScannerTimeframe();
  useScannerTruth(symbol, timeframe);
  return null;
}
function mount(timeframe?: string, header = true) {
  return render(<QueryClientProvider client={client}>
    {header && <HeaderObserver symbol="EURUSD" />}
    <RubyMarketReadCard symbol="EURUSD" timeframe={timeframe} />
  </QueryClientProvider>);
}
function switchTimeframe(timeframe: string) {
  act(() => {
    localStorage.setItem("scanner.chart.timeframe", timeframe);
    window.dispatchEvent(new CustomEvent("scanner:timeframe"));
  });
}
function requestTimeframe(request: typeof requests[number]) {
  return request.url.searchParams.get("timeframe") ?? request.url.searchParams.get("tf");
}

it("uses the chart timeframe and shares candle/selected reads with the header", () => {
  mount();
  expect(screen.getByText("EURUSD · 15m")).toBeTruthy();
  expect(requests).toHaveLength(4);
  expect(requests.every((request) => requestTimeframe(request) === "M15")).toBe(true);
  expect(requests.filter((request) => request.url.pathname.includes("/chart/candles"))).toHaveLength(1);
  expect(requests.filter((request) => request.url.pathname.includes("/selected-market"))).toHaveLength(1);
});

it("cancels obsolete read contexts on a timeframe change and unmount", async () => {
  const view = mount(); const previous = requests.slice();
  switchTimeframe("1h");
  expect(screen.getByText("EURUSD · 1h")).toBeTruthy();
  expect(requests).toHaveLength(8);
  expect(previous.every((request) => request.signal.aborted)).toBe(true);
  const current = requests.slice(4);
  expect(current.every((request) => requestTimeframe(request) === "H1")).toBe(true);
  // A transport that ignores cancellation must not publish its obsolete read
  // into either the current card or the current timeframe's query cache.
  await act(async () => {
    for (const request of previous) request.resolve(new Response(JSON.stringify({ signal: null, explanation: null, staleMarker: "M15" })));
  });
  await waitFor(() => expect(screen.getByText("EURUSD · 1h")).toBeTruthy());
  expect(client.getQueryCache().getAll().some((query) => (query.state.data as { staleMarker?: string } | undefined)?.staleMarker)).toBe(false);
  view.unmount(); expect(current.every((request) => request.signal.aborted)).toBe(true);
});

it("keeps explicit timeframe callers consistent across data and both gates", () => {
  mount("H1", false);
  expect(screen.getByText("EURUSD · 1h")).toBeTruthy();
  expect(requests).toHaveLength(4);
  expect(requests.every((request) => requestTimeframe(request) === "H1")).toBe(true);
  switchTimeframe("5m");
  expect(requests).toHaveLength(4);
  expect(screen.getByText("EURUSD · 1h")).toBeTruthy();
});

it("replaces symbol identity immediately and cancels the previous symbol's reads", async () => {
  const view = render(<QueryClientProvider client={client}><RubyMarketReadCard symbol="EURUSD" /></QueryClientProvider>);
  const previous = requests.slice();
  view.rerender(<QueryClientProvider client={client}><RubyMarketReadCard symbol="GBPUSD" /></QueryClientProvider>);
  expect(screen.getByText("GBPUSD · 15m")).toBeTruthy();
  expect(screen.queryByText("EURUSD · 15m")).toBeNull();
  expect(previous).toHaveLength(4);
  expect(previous.every((request) => request.signal.aborted)).toBe(true);
  const current = requests.slice(4);
  expect(current).toHaveLength(4);
  expect(current.every((request) => request.url.toString().includes("GBPUSD") && requestTimeframe(request) === "M15")).toBe(true);
  await act(async () => {
    for (const request of previous) request.resolve(new Response(JSON.stringify({ signal: null, explanation: null, staleMarker: "EURUSD" })));
  });
  expect(screen.getByText("GBPUSD · 15m")).toBeTruthy();
  expect(client.getQueryCache().getAll().some((query) => (query.state.data as { staleMarker?: string } | undefined)?.staleMarker)).toBe(false);
});

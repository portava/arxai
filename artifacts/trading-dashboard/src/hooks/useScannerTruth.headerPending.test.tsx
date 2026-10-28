// Truth regression: when the candles are live and complete but the slower
// /market-scanner/selected-market analysis is still loading (or failed), the
// scanner still withholds a live read, but it must say WHY truthfully. It may
// not claim "Data is incomplete" about candles that are complete, and a still-
// loading analysis reads as "Confirming market data", not "Historical read only".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, renderHook, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { chartCandlesQueryKey } from "@/lib/chartCandlesQuery";

const header = vi.hoisted(() => ({ value: { data: undefined as { ok: boolean } | undefined, isError: false } }));
vi.mock("@/hooks/useTradingMode", () => ({ useTradingMode: () => ({ isLoading: false, envelope: null }) }));
vi.mock("@/lib/assistant-name", () => ({ useAssistantName: () => ({ name: "Ruby" }) }));
vi.mock("@/hooks/useSelectedMarketSnapshot", () => ({ useSelectedMarketSnapshot: () => header.value }));
vi.mock("@/hooks/useScannerTimeframe", () => ({ useScannerTimeframe: () => ["1m"] }));

import { useScannerTruth } from "./useScannerTruth";
import { ScannerReadGate } from "@/components/scanner/ScannerReadGate";

const NOW = Date.parse("2026-10-28T12:00:00Z");
let client: QueryClient;

function seedLiveCandles() {
  const lastOpen = NOW - 10_000;
  client.setQueryData(chartCandlesQueryKey("EURUSD", "M1", 200), {
    candles: Array.from({ length: 200 }, (_, i) => ({
      time: lastOpen - (199 - i) * 60_000, open: 1.1, high: 1.11, low: 1.09, close: 1.1,
    })),
    feedStatus: { symbol: "EURUSD", source: "mt5_broker", quality: "clean", isLive: true, aiUsable: true, stale: false },
  });
}

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } } });
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
  seedLiveCandles();
});
afterEach(() => {
  cleanup(); client.clear(); vi.useRealTimers(); vi.unstubAllGlobals();
  header.value = { data: undefined, isError: false };
});

describe("useScannerTruth header cap reason", () => {
  it("still-loading analysis: withholds the live read without claiming the data is incomplete", () => {
    header.value = { data: undefined, isError: false };
    const { result } = renderHook(() => useScannerTruth("EURUSD", "1m", { refetchInterval: 3_600_000 }), { wrapper });
    const truth = result.current.truth!;
    expect(truth).not.toBeNull();
    // Downgrade kept.
    expect(truth.actionable).toBe(false);
    expect(truth.analysis.level).not.toBe("full");
    // Reason is true.
    expect(truth.candles.reason).not.toContain("Data is incomplete");
    expect(truth.candles.reason).toContain("still loading");
    expect(truth.dataHealth.headline).not.toBe("Historical data — analysis only");
    expect(truth.dataHealth.lines.join(" ")).not.toContain("Data is incomplete");
  });

  it("still-loading analysis: the read gate shows its pending wording", () => {
    header.value = { data: undefined, isError: false };
    render(<ScannerReadGate symbol="EURUSD" timeframe="1m" />, { wrapper });
    expect(screen.queryByText(/Historical read only/)).toBeNull();
    expect(screen.getByText(/Confirming market data/)).toBeTruthy();
    expect(screen.queryByText(/Data is incomplete/)).toBeNull();
  });

  it("analysis returned ok:false: says the analysis is unavailable, not that the data is incomplete", () => {
    header.value = { data: { ok: false }, isError: false };
    const { result } = renderHook(() => useScannerTruth("EURUSD", "1m", { refetchInterval: 3_600_000 }), { wrapper });
    const truth = result.current.truth!;
    expect(truth.actionable).toBe(false);
    expect(truth.candles.reason).not.toContain("Data is incomplete");
    expect(truth.candles.reason).toContain("analysis");
    expect(truth.candles.reason).toContain("unavailable");
  });

  it("analysis request failed: says the analysis could not be loaded", () => {
    header.value = { data: undefined, isError: true };
    const { result } = renderHook(() => useScannerTruth("EURUSD", "1m", { refetchInterval: 3_600_000 }), { wrapper });
    const truth = result.current.truth!;
    expect(truth.actionable).toBe(false);
    expect(truth.candles.reason).not.toContain("Data is incomplete");
    expect(truth.candles.reason).toContain("could not be loaded");
  });

  it("analysis ok: unchanged full live read", () => {
    header.value = { data: { ok: true }, isError: false };
    const { result } = renderHook(() => useScannerTruth("EURUSD", "1m", { refetchInterval: 3_600_000 }), { wrapper });
    expect(result.current.truth?.actionable).toBe(true);
  });
});

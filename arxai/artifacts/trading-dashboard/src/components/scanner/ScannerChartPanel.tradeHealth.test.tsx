// Trade-health overlays on the Scanner chart are drawn as labelled price lines
// at each open position's entry. React Query keeps the last successful response
// after a failed refetch, so before this guard the chart kept drawing the old
// positions' health while the caption said trade-health was unavailable. A
// failed check means health is unknown and the position may be gone: nothing
// from the earlier response is drawn until a check succeeds again.
//
// ScannerChartPanel itself cannot render headlessly (lightweight-charts), so the
// overlay list it draws is produced by the exported hook and tested here with a
// real QueryClient; the generated client hook is replaced by a plain useQuery
// with the same key and options.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

const tradeHealthFn = vi.fn<() => Promise<{ overlays: unknown[] }>>();

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    useGetMeTradeHealth: (
      _params: unknown,
      options: { query: { queryKey: readonly unknown[]; refetchInterval?: number } },
    ) => useQuery({ queryKey: options.query.queryKey, queryFn: () => tradeHealthFn(), retry: false }),
  };
});

import { useScannerTradeHealthOverlays } from "./ScannerChartPanel";

const OVERLAY = {
  id: "th-1",
  group: "trade_health",
  kind: "line",
  price: 1.0842,
  label: "EURUSD long · healthy",
  severity: "ok",
  reserved: false,
};

// The panel reads `isError` while rendering (its caption), which makes React
// Query's tracked result re-render on an error; read it here the same way.
function usePanelTradeHealth() {
  const r = useScannerTradeHealthOverlays("EURUSD");
  return { ...r, isError: r.query.isError };
}

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  tradeHealthFn.mockReset();
});
afterEach(() => {
  cleanup();
  client.clear();
});

describe("Scanner chart trade-health overlays", () => {
  it("draws the overlays from a successful check", async () => {
    tradeHealthFn.mockResolvedValue({ overlays: [OVERLAY] });
    const { result } = renderHook(usePanelTradeHealth, { wrapper });
    await waitFor(() => expect(result.current.overlays).toHaveLength(1));
    expect(result.current.overlays[0]!.label).toBe("EURUSD long · healthy");
  });

  it("draws nothing from the earlier response once the latest check fails", async () => {
    tradeHealthFn.mockResolvedValueOnce({ overlays: [OVERLAY] });
    const { result } = renderHook(usePanelTradeHealth, { wrapper });
    await waitFor(() => expect(result.current.overlays).toHaveLength(1));

    tradeHealthFn.mockRejectedValueOnce(new Error("503"));
    await act(async () => {
      await result.current.query.refetch();
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    // React Query still holds the earlier data …
    expect(result.current.query.data?.overlays).toHaveLength(1);
    // … but none of it is drawn as current.
    expect(result.current.overlays).toEqual([]);

    tradeHealthFn.mockResolvedValueOnce({ overlays: [OVERLAY] });
    await act(async () => {
      await result.current.query.refetch();
    });
    await waitFor(() => expect(result.current.overlays).toHaveLength(1));
  });
});

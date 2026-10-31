import { useCallback, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { preloadMarketScannerPage } from "@/lib/scannerRoute";
import { bareSymbol, useChartSymbol } from "@/lib/use-chart-symbol";
import { useScannerTimeframe } from "@/hooks/useScannerTimeframe";
import { chartCandlesQueryKey, fetchChartCandles, toApiTimeframe } from "@/lib/chartCandlesQuery";
import { isChartInterval } from "@/lib/chart-engine/chartIntervals";

/** Warm code at idle; fetch only on explicit navigation intent. No polling,
 * analysis, streams, positions or orders start before the page is mounted. */
export function useScannerNavigationWarmup(allowed: boolean, idle = true) {
  const client = useQueryClient();
  const [chartSymbol] = useChartSymbol();
  const [timeframe] = useScannerTimeframe();
  useEffect(() => {
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
    if (!allowed || !idle || connection?.saveData || document.visibilityState === "hidden") return;
    const warm = () => {
      if (document.visibilityState !== "hidden") preloadMarketScannerPage();
    };
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(warm);
      return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(warm, 1500);
    return () => window.clearTimeout(id);
  }, [allowed, idle]);

  return useCallback((href: string) => {
    if (!allowed || href !== "/market-scanner") return;
    preloadMarketScannerPage();
    const symbol = bareSymbol(chartSymbol).toUpperCase();
    const apiTf = toApiTimeframe(timeframe);
    if (!symbol || !isChartInterval(apiTf)) return;
    // Exactly the mounted chart's key, transport and freshness budget. The
    // response retains its original evidence; prefetching never makes it live.
    void client.prefetchQuery({
      queryKey: chartCandlesQueryKey(symbol, apiTf, 200),
      queryFn: ({ signal }) => fetchChartCandles(symbol, apiTf, 200, signal),
      staleTime: 5000,
      retry: false,
    });
  }, [allowed, client, chartSymbol, timeframe]);
}

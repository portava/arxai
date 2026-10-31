import { useCallback, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { preloadMarketScannerPage } from "@/lib/scannerRoute";
import { bareSymbol, useChartSymbol } from "@/lib/use-chart-symbol";
import { useScannerTimeframe } from "@/hooks/useScannerTimeframe";
import { chartCandlesQueryKey, fetchChartCandles, toApiTimeframe } from "@/lib/chartCandlesQuery";
import { isChartInterval } from "@/lib/chart-engine/chartIntervals";

/** Warm the selected chart once while idle, then share that same request with
 * explicit navigation intent and the mounted page. No refresh timer, analysis,
 * streams, positions or orders start before the page is mounted. */
export function useScannerNavigationWarmup(allowed: boolean, idle = true) {
  const client = useQueryClient();
  const [chartSymbol] = useChartSymbol();
  const [timeframe] = useScannerTimeframe();
  const warm = useCallback((href: string) => {
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

  useEffect(() => {
    const idleAllowed = () => {
      const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
      return document.visibilityState !== "hidden" && !connection?.saveData;
    };
    if (!allowed || !idle || !idleAllowed()) return;
    const prepare = () => { if (idleAllowed()) warm("/market-scanner"); };
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(prepare);
      return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(prepare, 1500);
    return () => window.clearTimeout(id);
  }, [allowed, idle, warm]);
  return warm;
}

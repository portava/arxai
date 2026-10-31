// Shared scanner timeframe (Task #391).
//
// The chart panel and the header truth strip must resolve scanner truth for the
// SAME timeframe, otherwise their freshness/min-candle verdicts can disagree.
// localStorage alone is not reactive within a tab, so writes broadcast a custom
// event that every consumer in the page listens for.

import { useCallback, useEffect, useState } from "react";
import { chartIntervalDisplayId, parseChartInterval, restoreChartInterval } from "@/lib/chart-engine/chartIntervals";

const TF_KEY = "scanner.chart.timeframe";
const TF_EVENT = "scanner:timeframe";
const DEFAULT_TF = "15m";

export function loadScannerTimeframe(): string {
  if (typeof window === "undefined") return DEFAULT_TF;
  try { return chartIntervalDisplayId(restoreChartInterval(window.localStorage.getItem(TF_KEY))); }
  catch { return DEFAULT_TF; }
}

export function useScannerTimeframe(): [string, (tf: string) => void] {
  const [tf, setTf] = useState<string>(() => loadScannerTimeframe());

  useEffect(() => {
    const sync = (event: Event) => {
      // Same-tab delivery carries the actual choice even if browser storage
      // cannot be written. Other mounted Scanner consumers must not reset it.
      const choice = event instanceof CustomEvent ? parseChartInterval(event.detail) : null;
      if (choice) setTf(chartIntervalDisplayId(choice));
      else if (!(event instanceof StorageEvent) || event.key == null || event.key === TF_KEY) setTf(loadScannerTimeframe());
    };
    window.addEventListener(TF_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(TF_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const update = useCallback((next: string) => {
    const normalized = chartIntervalDisplayId(restoreChartInterval(next));
    try {
      window.localStorage.setItem(TF_KEY, normalized);
    } catch {
      /* storage unavailable */
    }
    setTf(normalized);
    window.dispatchEvent(new CustomEvent(TF_EVENT, { detail: normalized }));
  }, []);

  return [tf, update];
}

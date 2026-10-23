// Shared scanner timeframe (Task #391).
//
// The chart panel and the header truth strip must resolve scanner truth for the
// SAME timeframe, otherwise their freshness/min-candle verdicts can disagree.
// localStorage alone is not reactive within a tab, so writes broadcast a custom
// event that every consumer in the page listens for.

import { useCallback, useEffect, useState } from "react";

const TF_KEY = "scanner.chart.timeframe";
const TF_EVENT = "scanner:timeframe";
const DEFAULT_TF = "15m";

export function loadScannerTimeframe(): string {
  if (typeof window === "undefined") return DEFAULT_TF;
  return localStorage.getItem(TF_KEY) || DEFAULT_TF;
}

export function useScannerTimeframe(): [string, (tf: string) => void] {
  const [tf, setTf] = useState<string>(() => loadScannerTimeframe());

  useEffect(() => {
    const sync = () => setTf(loadScannerTimeframe());
    window.addEventListener(TF_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(TF_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const update = useCallback((next: string) => {
    try {
      window.localStorage.setItem(TF_KEY, next);
    } catch {
      /* storage unavailable */
    }
    setTf(next);
    window.dispatchEvent(new CustomEvent(TF_EVENT));
  }, []);

  return [tf, update];
}

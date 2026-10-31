import { useEffect, useState } from "react";
import { nextScannerMapFreshnessChange } from "./scannerMapFreshness";

type OpportunityStamp = {
  generatedAt?: string | null;
  scanGeneratedAt?: string | null;
  dataStatus?: string;
  tradeable?: boolean;
};

/** Wake only at a possible verdict change. Action handlers must still read the
 * current clock at the click boundary; a throttled background timer is not an
 * execution permission. The clock is read on every render, including new data. */
export function useScannerOpportunityClock(rows: readonly OpportunityStamp[], held: OpportunityStamp | null): number {
  const [tick, setTick] = useState(0);
  const now = Date.now();
  let next: number | null = null;
  const visit = (row: OpportunityStamp) => {
    if (row.dataStatus !== "live" || row.tradeable !== true) return;
    for (const stamp of [row.generatedAt, row.scanGeneratedAt]) {
      const at = nextScannerMapFreshnessChange(stamp, now);
      if (at !== null && (next === null || at < next)) next = at;
    }
  };
  rows.forEach(visit);
  if (held) visit(held);
  useEffect(() => {
    if (next === null) return;
    const timer = setTimeout(() => setTick(t => t + 1), Math.min(Math.max(0, next - Date.now()), 0x7fffffff));
    return () => clearTimeout(timer);
  }, [next, tick]);
  // Recheck after background throttling or a system-clock change on return.
  useEffect(() => {
    const refresh = () => setTick(t => t + 1);
    const visible = () => { if (!document.hidden) refresh(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", visible);
    };
  }, []);
  return now;
}

// useScannerReadGate — the shared "is this read actionable?" decision derived
// from the ONE scanner-truth contract (Task #391).
//
// Every advisory surface that renders confidence/actionable content (the
// ScannerReadGate banner, Ruby Market Read, Timing Intelligence) consumes this
// so the downgrade decision is computed ONCE, from the same truth, against the
// same scanner timeframe. A card can therefore never present a confident,
// actionable read while the shared truth says the data is historical / limited /
// blocked.

import { useScannerTimeframe } from "@/hooks/useScannerTimeframe";
import { useScannerTruth } from "@/hooks/useScannerTruth";
import type { ScannerTruth } from "@/lib/scannerTruth";

export type ScannerAnalysisLevel = ScannerTruth["analysis"]["level"];

export interface ScannerReadGateState {
  truth: ScannerTruth | null;
  level: ScannerAnalysisLevel | null;
  /** Truth resolved AND fully actionable (analysis.level === "full"). */
  isFull: boolean;
  /** True until truth positively confirms a full read, including loading/error. */
  downgraded: boolean;
  /**
   * True when there is no truth because its candles request FAILED (not
   * because it is still loading): the live-feed check could not be loaded.
   * Absent/false while pending.
   */
  loadFailed?: boolean;
  reason: string | null;
}

export function useScannerReadGate(symbol: string, timeframe?: string): ScannerReadGateState {
  const [scannerTimeframe] = useScannerTimeframe();
  const { truth, isError } = useScannerTruth(symbol, timeframe || scannerTimeframe);
  const level = truth?.analysis.level ?? null;
  const isFull = level === "full";
  const loadFailed = truth == null && isError === true;
  return {
    truth,
    level,
    isFull,
    downgraded: !isFull,
    loadFailed,
    reason: truth?.analysis.reason ?? (loadFailed
      ? "The live-feed check for this market could not be loaded — directional reads and trade ideas are withheld."
      : "Confirming this market's live feed — directional reads and trade ideas are withheld."),
  };
}

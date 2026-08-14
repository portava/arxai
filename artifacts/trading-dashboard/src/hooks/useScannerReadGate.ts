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
  /** Truth resolved AND NOT fully actionable — actionable content must downgrade. */
  downgraded: boolean;
  reason: string | null;
}

export function useScannerReadGate(symbol: string): ScannerReadGateState {
  const [timeframe] = useScannerTimeframe();
  const { truth } = useScannerTruth(symbol, timeframe);
  const level = truth?.analysis.level ?? null;
  const isFull = level === "full";
  return {
    truth,
    level,
    isFull,
    downgraded: truth != null && !isFull,
    reason: truth?.analysis.reason ?? null,
  };
}

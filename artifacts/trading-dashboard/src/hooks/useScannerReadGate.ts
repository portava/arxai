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
  /**
   * NOT fully actionable — actionable content must downgrade. FAIL-CLOSED:
   * a null truth (fetch failed, still resolving, or never ran) is downgraded
   * too — a gate that fails open would let confident GO/grade/score gauges
   * render exactly when the feed-truth check itself is broken.
   */
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
    // Fail-closed: only a resolved, fully-actionable truth lifts the gate.
    downgraded: !isFull,
    reason:
      truth?.analysis.reason ??
      (truth == null
        ? "The live-feed truth check hasn't confirmed this symbol yet."
        : null),
  };
}

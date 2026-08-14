// ═══════════════════════════════════════════════════════════════════════════
// Execution Benchmark
//
// Compares the actual fill against an arrival-price benchmark and against
// the decision price. Reports signed pip slippage (positive = adverse).
//
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

import { type Side, pipsBetween } from "./executionIntelligence.types";

export interface BenchmarkInput {
  side: Side;
  fillPrice: number;
  arrivalPrice: number;
  decisionPrice: number;
  spreadAtSignalPips: number;
  spreadAtFillPips: number;
  latencyAtDecisionMs: number;
  latencyAtFillMs: number;
  pipSize: number;
}

export interface BenchmarkResult {
  arrivalPriceSlippagePips: number;
  decisionPriceSlippagePips: number;
  spreadDeltaPips: number;
  latencyDeltaMs: number;
}

export function benchmarkExecution(b: BenchmarkInput): BenchmarkResult {
  return {
    arrivalPriceSlippagePips:  pipsBetween(b.side, b.fillPrice, b.arrivalPrice,  b.pipSize),
    decisionPriceSlippagePips: pipsBetween(b.side, b.fillPrice, b.decisionPrice, b.pipSize),
    spreadDeltaPips: b.spreadAtFillPips - b.spreadAtSignalPips,
    latencyDeltaMs:  b.latencyAtFillMs  - b.latencyAtDecisionMs,
  };
}

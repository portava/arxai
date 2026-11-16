import { z } from "zod/v4";
import { simulateSlippage, type MarketConditions, type OrderRequest } from "./slippageSimulation.engine";
import { simulateLatency } from "./latencySimulation.engine";
import { simulatePartialFill } from "./partialFill.engine";

export const BrokerOutcomeSchema = z.enum(["FILLED", "PARTIAL", "REJECTED", "REQUOTED"]);
export type BrokerOutcome = z.infer<typeof BrokerOutcomeSchema>;

export interface BrokerSimResult {
  outcome: BrokerOutcome;
  filledLots: number;
  filledPrice: number;
  slippagePips: number;
  latencyMs: number;
  reasons: string[];
}

export const BROKER_STRESS_THRESHOLDS = {
  rejectLatencyMs: 1500,                // if total latency over this, broker may reject
  requoteSlippagePips: 8,               // slippage beyond this triggers a requote
  rejectFillFraction: 0.20,             // fill fraction below this → rejected entirely
} as const;

// simulateBrokerExecution — orchestrate slippage + latency + partial fill
// to produce a single realistic broker outcome. Composes the four
// underlying engines.
//
// Outcome priority:
//   1. latency too high  → REJECTED
//   2. slippage too wide → REQUOTED (no fill)
//   3. fill fraction below floor → REJECTED
//   4. fill fraction < 1 → PARTIAL
//   5. else → FILLED
export function simulateBrokerExecution(req: OrderRequest, mkt: MarketConditions): BrokerSimResult {
  const T = BROKER_STRESS_THRESHOLDS;
  const reasons: string[] = [];

  const lat = simulateLatency(mkt);
  reasons.push(...lat.reasons);
  if (lat.totalLatencyMs >= T.rejectLatencyMs) {
    return {
      outcome: "REJECTED", filledLots: 0, filledPrice: req.intendedPrice,
      slippagePips: 0, latencyMs: lat.totalLatencyMs,
      reasons: [...reasons, `latency ${lat.totalLatencyMs}ms ≥ ${T.rejectLatencyMs}ms — REJECTED`],
    };
  }

  const slip = simulateSlippage(req, mkt);
  reasons.push(...slip.reasons);
  if (slip.slippagePips >= T.requoteSlippagePips) {
    return {
      outcome: "REQUOTED", filledLots: 0, filledPrice: slip.adjustedFillPrice,
      slippagePips: slip.slippagePips, latencyMs: lat.totalLatencyMs,
      reasons: [...reasons, `slippage ${slip.slippagePips.toFixed(1)}p ≥ ${T.requoteSlippagePips}p — REQUOTED`],
    };
  }

  const fill = simulatePartialFill(req, mkt);
  reasons.push(...fill.reasons);
  if (fill.filledFraction01 < T.rejectFillFraction) {
    return {
      outcome: "REJECTED", filledLots: 0, filledPrice: req.intendedPrice,
      slippagePips: slip.slippagePips, latencyMs: lat.totalLatencyMs,
      reasons: [...reasons, `fill fraction ${(fill.filledFraction01 * 100).toFixed(0)}% < ${(T.rejectFillFraction * 100).toFixed(0)}% — REJECTED`],
    };
  }

  const outcome: BrokerOutcome = fill.filledFraction01 < 1 ? "PARTIAL" : "FILLED";
  return {
    outcome, filledLots: fill.filledLots, filledPrice: slip.adjustedFillPrice,
    slippagePips: slip.slippagePips, latencyMs: lat.totalLatencyMs, reasons,
  };
}

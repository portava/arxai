import type {
  ExecutionResult, FillReport, OrderSpec,
} from "../agentSystem.types";

// fillVerification — compares ExecutionResult against the OrderSpec.
// Verifies the fill matched what was asked for and that slippage was
// within budget. Pip-aware: caller passes pipSize.
export function verifyFill(
  result: ExecutionResult,
  pipSize: number,
): FillReport {
  const reasons: string[] = [];

  if (result.status !== "FILLED") {
    reasons.push(`status ${result.status} — no fill to verify`);
    return { matchesRequested: false, pipsDeviation: 0, withinSlippageBudget: false, reasons };
  }
  if (result.fillPrice === null) {
    reasons.push("FILLED but fillPrice null — broker response malformed");
    return { matchesRequested: false, pipsDeviation: 0, withinSlippageBudget: false, reasons };
  }
  if (pipSize <= 0) {
    reasons.push("invalid pipSize ≤ 0 — cannot compute deviation in pips");
    return { matchesRequested: false, pipsDeviation: 0, withinSlippageBudget: false, reasons };
  }

  const order: OrderSpec = result.orderSpec;
  const sign = order.direction === "BUY" ? 1 : -1;
  const pipsDeviation = (sign * (result.fillPrice - order.entryPrice)) / pipSize;
  const withinSlippageBudget = Math.abs(pipsDeviation) <= order.slippagePipsBudget;

  reasons.push(`fill ${result.fillPrice} vs requested ${order.entryPrice} — ${pipsDeviation.toFixed(2)} pips deviation (budget ±${order.slippagePipsBudget})`);
  if (!withinSlippageBudget) reasons.push("OUTSIDE slippage budget — flag for review");

  return {
    matchesRequested: order.lotSize > 0 && result.brokerOrderId !== null,
    pipsDeviation, withinSlippageBudget, reasons,
  };
}

import type {
  ExecutionPort, ExecutionResult, OrderSpec,
} from "../agentSystem.types";

// mt5Execution — sends the OrderSpec via the typed ExecutionPort and
// normalizes the broker response into an ExecutionResult. The Port is
// injected (no IO logic here); a real impl would wrap the MT5 bridge.
//
// Slippage is computed from the requested entry vs the actual fill price.
// Direction-aware: BUY pays positive slippage on a higher fill, SELL on a
// lower fill.
export async function executeOrderViaMt5(
  port: ExecutionPort,
  order: OrderSpec,
): Promise<ExecutionResult> {
  const reasons: string[] = [];
  const blockers: string[] = [];

  let raw;
  try {
    raw = await port.sendOrder(order);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    blockers.push(`port threw: ${msg}`);
    return {
      status: "ERROR", orderSpec: order,
      brokerOrderId: null, fillPrice: null, fillSlippagePips: null, fillTime: null,
      reasons: [`execution port threw — order NOT considered sent`], blockers,
    };
  }

  if (!raw.ok) {
    blockers.push(raw.errorCode ?? "broker_rejected");
    reasons.push(`rejected by broker: ${raw.errorMessage ?? raw.errorCode ?? "unknown"}`);
    return {
      status: "REJECTED_BY_BROKER", orderSpec: order,
      brokerOrderId: null, fillPrice: null, fillSlippagePips: null, fillTime: null,
      reasons, blockers,
    };
  }

  const fillPrice = raw.fillPrice ?? null;
  let fillSlippagePips: number | null = null;
  if (fillPrice !== null) {
    const sign = order.direction === "BUY" ? 1 : -1;
    // Pip size unknown here; report price delta as pips assuming caller's
    // OrderSpec entryPrice was already in pip-aligned units. Without pipSize
    // we surface the raw delta and leave verification to fillVerification.
    fillSlippagePips = sign * (fillPrice - order.entryPrice);
    reasons.push(`filled @ ${fillPrice} (slippage ${fillSlippagePips.toFixed(4)} price units, ${order.direction})`);
  } else {
    reasons.push("broker confirmed but no fill price — partial or pending");
  }

  return {
    status: fillPrice !== null ? "FILLED" : "PARTIAL",
    orderSpec: order,
    brokerOrderId: raw.brokerOrderId ?? null,
    fillPrice, fillSlippagePips, fillTime: raw.fillTime ?? null,
    reasons, blockers,
  };
}

// Convenience helper: returns a NOT_SENT result for the case when execution
// is skipped because the governor rejected (no order was prepared).
export function notSentResult(reason: string): ExecutionResult {
  return {
    status: "NOT_SENT",
    orderSpec: null as unknown as OrderSpec,
    brokerOrderId: null, fillPrice: null, fillSlippagePips: null, fillTime: null,
    reasons: [reason], blockers: [],
  };
}

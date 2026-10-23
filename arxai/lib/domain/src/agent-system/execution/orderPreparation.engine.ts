import type {
  AgentSystemSnapshot, GovernorReview, OrderSpec,
} from "../agentSystem.types";

// orderPreparation — converts an APPROVED snapshot + governor review into
// a concrete OrderSpec. Refuses to prepare a spec when governor rejected.
export function prepareOrder(
  snap: AgentSystemSnapshot,
  governor: GovernorReview,
  clientOrderId: string,
): OrderSpec | null {
  if (governor.finalAction === "REJECT") return null;
  return {
    clientOrderId,
    symbol: snap.setup.symbol,
    direction: snap.setup.direction,
    lotSize: round2(snap.setup.lotSize * governor.finalSizeMultiplier),
    entryPrice: snap.setup.intendedEntryPrice,
    stopLoss: snap.setup.stopLoss,
    takeProfit: snap.setup.takeProfit,
    slippagePipsBudget: snap.policy.slippagePipsBudget,
  };
}
function round2(n: number) { return Math.round(n * 100) / 100; }

import type { PromotionDecision, TrustLadderStorePort, TrustRung } from "./trustLadder.types";

export function createInMemoryTrustLadderStore(): TrustLadderStorePort {
  let current: { rung: TrustRung; atIso: string } | null = null;
  const decisions: { decision: PromotionDecision; atIso: string }[] = [];
  return {
    async saveCurrentRung(rung, atIso) { current = { rung, atIso }; },
    async loadCurrentRung() { return current ? { ...current } : null; },
    async appendDecision(decision, atIso) {
      decisions.push({
        decision: { ...decision, failedGates: [...decision.failedGates], reasons: [...decision.reasons] },
        atIso,
      });
    },
    async listDecisions() {
      return decisions.map((d) => ({
        decision: { ...d.decision, failedGates: [...d.decision.failedGates], reasons: [...d.decision.reasons] },
        atIso: d.atIso,
      }));
    },
  };
}

import type { ApprovalRegistryPort, ApprovalTier } from "./executionAi.types";

export function createInMemoryApprovalRegistry(): ApprovalRegistryPort {
  const tiers = new Map<string, { tier: ApprovalTier; atIso: string }>();
  return {
    async getApprovalTier(strategyId) { return tiers.get(strategyId)?.tier ?? "NOT_APPROVED"; },
    async setApprovalTier(strategyId, tier, atIso) { tiers.set(strategyId, { tier, atIso }); },
  };
}

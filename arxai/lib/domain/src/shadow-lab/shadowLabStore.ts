import type {
  OutcomeComparison, PairClassification, ShadowDecisionPair, ShadowLabStorePort,
} from "./shadowLab.types";

export function createInMemoryShadowLabStore(): ShadowLabStorePort {
  const pairs = new Map<string, ShadowDecisionPair>();
  const classifications = new Map<string, PairClassification>();
  const outcomes = new Map<string, OutcomeComparison>();
  return {
    async putPair(p) { pairs.set(p.pairId, { ...p }); },
    async putClassification(c) { classifications.set(c.pairId, { ...c }); },
    async putOutcome(o) { outcomes.set(o.pairId, { ...o }); },
    async listOutcomes(filter) {
      let arr = Array.from(outcomes.values());
      if (filter?.since || filter?.until) {
        arr = arr.filter((o) => {
          const p = pairs.get(o.pairId);
          if (!p) return false;
          const t = Date.parse(p.recordedAt);
          if (filter.since && t < filter.since.getTime()) return false;
          if (filter.until && t > filter.until.getTime()) return false;
          return true;
        });
      }
      return arr;
    },
  };
}

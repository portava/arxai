import {
  type BehaviorTruthRecord, type VaultQuery,
  matchesEnvelope, applyLimit,
} from "./blackBox.types";

// ═══════════════════════════════════════════════════════════════════════════
// Behavior Truth Store — every human / operator action. Project rule:
// every override must be logged. Used to learn Trader DNA and detect
// destructive override patterns.
// ═══════════════════════════════════════════════════════════════════════════

export interface BehaviorTruthStorePort {
  append(record: BehaviorTruthRecord): Promise<void>;
  list(query?: VaultQuery): Promise<BehaviorTruthRecord[]>;
  byTrade(tradeId: string): Promise<BehaviorTruthRecord[]>;
  byDecision(decisionId: string): Promise<BehaviorTruthRecord[]>;
}

export function createInMemoryBehaviorTruthStore(): BehaviorTruthStorePort {
  const records: BehaviorTruthRecord[] = [];
  const ids = new Set<string>();
  return {
    async append(r) {
      if (ids.has(r.behaviorId)) {
        throw new Error(`behaviorId ${r.behaviorId} already exists — behaviour truth is append-only`);
      }
      ids.add(r.behaviorId);
      records.push(copy(r));
    },
    async list(query) {
      const q = query ?? {};
      const out = records.map(copy).filter((r) => matchesEnvelope(r, q));
      return applyLimit(out, q.limit);
    },
    async byTrade(tradeId) {
      return records.filter((r) => r.targetTradeId === tradeId).map(copy);
    },
    async byDecision(decisionId) {
      return records.filter((r) => r.targetDecisionId === decisionId).map(copy);
    },
  };
}

function copy(r: BehaviorTruthRecord): BehaviorTruthRecord {
  return { ...r, reasons: [...r.reasons] };
}

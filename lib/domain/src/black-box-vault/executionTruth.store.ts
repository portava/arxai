import {
  type ExecutionTruthRecord, type VaultQuery,
  matchesEnvelope, applyLimit,
} from "./blackBox.types";

// ═══════════════════════════════════════════════════════════════════════════
// Execution Truth Store — what the broker actually filled. Captures
// slippage, latency, fill price vs requested, and spread at fill.
// Used for execution-quality analysis and shadow-vs-live comparison.
// ═══════════════════════════════════════════════════════════════════════════

export interface ExecutionTruthStorePort {
  append(record: ExecutionTruthRecord): Promise<void>;
  list(query?: VaultQuery): Promise<ExecutionTruthRecord[]>;
  byTrade(tradeId: string): Promise<ExecutionTruthRecord[]>;
  byId(executionId: string): Promise<ExecutionTruthRecord | null>;
}

export function createInMemoryExecutionTruthStore(): ExecutionTruthStorePort {
  const records = new Map<string, ExecutionTruthRecord>();
  return {
    async append(r) {
      if (records.has(r.executionId)) {
        throw new Error(`executionId ${r.executionId} already exists — execution truth is immutable`);
      }
      records.set(r.executionId, copy(r));
    },
    async list(query) {
      const q = query ?? {};
      const out = [...records.values()].map(copy).filter((r) => matchesEnvelope(r, q));
      return applyLimit(out, q.limit);
    },
    async byTrade(tradeId) {
      return [...records.values()].filter((r) => r.tradeId === tradeId).map(copy);
    },
    async byId(id) {
      const r = records.get(id);
      return r ? copy(r) : null;
    },
  };
}

function copy(r: ExecutionTruthRecord): ExecutionTruthRecord {
  return { ...r, reasons: [...r.reasons] };
}

import {
  type OutcomeTruthRecord, type VaultQuery,
  matchesEnvelope, applyLimit,
} from "./blackBox.types";

// ═══════════════════════════════════════════════════════════════════════════
// Outcome Truth Store — what actually happened in the end: P&L, audit
// score, lesson text. The closing chapter of every trade. Bridges AI
// confidence to real outcome (predictionErrorAbs).
// ═══════════════════════════════════════════════════════════════════════════

export interface OutcomeTruthStorePort {
  append(record: OutcomeTruthRecord): Promise<void>;
  list(query?: VaultQuery): Promise<OutcomeTruthRecord[]>;
  byTrade(tradeId: string): Promise<OutcomeTruthRecord | null>;
  byId(outcomeId: string): Promise<OutcomeTruthRecord | null>;
}

export function createInMemoryOutcomeTruthStore(): OutcomeTruthStorePort {
  const records = new Map<string, OutcomeTruthRecord>();
  const tradeIndex = new Set<string>();          // 1 outcome per tradeId
  return {
    async append(r) {
      if (records.has(r.outcomeId)) {
        throw new Error(`outcomeId ${r.outcomeId} already exists — outcome truth is immutable`);
      }
      if (tradeIndex.has(r.tradeId)) {
        throw new Error(`outcome already exists for tradeId ${r.tradeId} — one outcome per trade`);
      }
      records.set(r.outcomeId, copy(r));
      tradeIndex.add(r.tradeId);
    },
    async list(query) {
      const q = query ?? {};
      const out = [...records.values()].map(copy).filter((r) => matchesEnvelope(r, q));
      return applyLimit(out, q.limit);
    },
    async byTrade(tradeId) {
      const r = [...records.values()].find((x) => x.tradeId === tradeId);
      return r ? copy(r) : null;
    },
    async byId(id) {
      const r = records.get(id);
      return r ? copy(r) : null;
    },
  };
}

function copy(r: OutcomeTruthRecord): OutcomeTruthRecord {
  return { ...r, reasons: [...r.reasons] };
}

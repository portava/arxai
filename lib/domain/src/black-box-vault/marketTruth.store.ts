import {
  type MarketTruthRecord, type VaultQuery,
  matchesEnvelope, applyLimit,
} from "./blackBox.types";

// ═══════════════════════════════════════════════════════════════════════════
// Market Truth Store — immutable, append-only record of what the market
// looked like at every decision-relevant moment. Forms the "external
// reality" half of every replay packet.
// ═══════════════════════════════════════════════════════════════════════════

export interface MarketTruthStorePort {
  append(record: MarketTruthRecord): Promise<void>;
  list(query?: VaultQuery): Promise<MarketTruthRecord[]>;
  byId(marketTruthId: string): Promise<MarketTruthRecord | null>;
}

export function createInMemoryMarketTruthStore(): MarketTruthStorePort {
  const records = new Map<string, MarketTruthRecord>();
  return {
    async append(r) {
      if (records.has(r.marketTruthId)) {
        throw new Error(`marketTruthId ${r.marketTruthId} already exists — market truth is immutable`);
      }
      records.set(r.marketTruthId, copy(r));
    },
    async list(query) {
      const q = query ?? {};
      const out = [...records.values()].map(copy).filter((r) => matchesEnvelope(r, q));
      return applyLimit(out, q.limit);
    },
    async byId(id) {
      const r = records.get(id);
      return r ? copy(r) : null;
    },
  };
}

function copy(r: MarketTruthRecord): MarketTruthRecord {
  return { ...r };
}

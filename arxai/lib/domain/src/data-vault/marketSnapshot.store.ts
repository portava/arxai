import {
  type MarketSnapshot, type VaultQuery,
  matchesEnvelope, applyLimit,
} from "./dataVault.types";

// ═══════════════════════════════════════════════════════════════════════════
// Market Snapshot Store — point-in-time market context attached to every
// decision: regime, session, spread, latency, volatility, plus an opaque
// featuresJson blob. Used to make every decision REPLAYABLE (you can
// reconstruct exactly what the AI saw).
// ═══════════════════════════════════════════════════════════════════════════

export interface MarketSnapshotStorePort {
  append(snapshot: MarketSnapshot): Promise<void>;
  list(query?: VaultQuery): Promise<MarketSnapshot[]>;
  byId(snapshotId: string): Promise<MarketSnapshot | null>;
}

export function createInMemoryMarketSnapshotStore(): MarketSnapshotStorePort {
  const snapshots = new Map<string, MarketSnapshot>();
  return {
    async append(snapshot) {
      // Snapshots are immutable — refuse overwrite.
      if (snapshots.has(snapshot.snapshotId)) {
        throw new Error(`snapshotId ${snapshot.snapshotId} already exists — market snapshots are immutable`);
      }
      snapshots.set(snapshot.snapshotId, copy(snapshot));
    },
    async list(query) {
      const q = query ?? {};
      const filtered = [...snapshots.values()]
        .map(copy)
        .filter((s) => matchesEnvelope(s, q));
      return applyLimit(filtered, q.limit);
    },
    async byId(snapshotId) {
      const s = snapshots.get(snapshotId);
      return s ? copy(s) : null;
    },
  };
}

function copy(s: MarketSnapshot): MarketSnapshot {
  return { ...s };
}

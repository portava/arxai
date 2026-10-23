import {
  type StrategyPerformanceSnapshot, type StrategyId, type VaultQuery,
  matchesEnvelope, applyLimit,
} from "./dataVault.types";

// ═══════════════════════════════════════════════════════════════════════════
// Strategy Performance Store — periodic snapshots of strategy performance
// per (strategy, regime, session, symbol) tuple. Append-only time series.
// Used by the lifecycle / promotion / demotion engines and by humans for
// quick "how is X doing?" queries.
// ═══════════════════════════════════════════════════════════════════════════

export interface StrategyPerformanceStorePort {
  append(snapshot: StrategyPerformanceSnapshot): Promise<void>;
  list(query?: VaultQuery): Promise<StrategyPerformanceSnapshot[]>;
  /** Latest snapshot for a strategy (most recent recordedAtIso). */
  latestFor(strategyId: StrategyId): Promise<StrategyPerformanceSnapshot | null>;
}

export function createInMemoryStrategyPerformanceStore(): StrategyPerformanceStorePort {
  const snapshots: StrategyPerformanceSnapshot[] = [];
  const ids = new Set<string>();
  return {
    async append(snapshot) {
      if (ids.has(snapshot.snapshotId)) {
        throw new Error(`strategy performance snapshotId ${snapshot.snapshotId} already exists — append-only`);
      }
      ids.add(snapshot.snapshotId);
      snapshots.push(copy(snapshot));
    },
    async list(query) {
      const q = query ?? {};
      const filtered = snapshots.map(copy).filter((s) => matchesEnvelope(s, q));
      return applyLimit(filtered, q.limit);
    },
    async latestFor(strategyId) {
      const matching = snapshots.filter((s) => s.strategyId === strategyId);
      if (matching.length === 0) return null;
      // Defensive: don't assume insertion order — pick max by recordedAtIso.
      const latest = matching.reduce((a, b) => (b.recordedAtIso > a.recordedAtIso ? b : a));
      return copy(latest);
    },
  };
}

function copy(s: StrategyPerformanceSnapshot): StrategyPerformanceSnapshot {
  return { ...s, reasons: [...s.reasons] };
}

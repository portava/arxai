import {
  type ReplayBundle, type TradeId, type VaultQuery,
  matchesEnvelope, applyLimit,
} from "./dataVault.types";

// ═══════════════════════════════════════════════════════════════════════════
// Replay Dataset Store — assembled REPLAY BUNDLES that point at the IDs
// needed to re-derive a trade decision: decisions, votes, market snapshots.
// Project rule: every trade must be replayable — every trade should have
// at least one bundle here.
//
// Bundles are append-only and immutable; rebuilding produces a NEW bundleId.
// Lookups: by tradeId, by id, by full universal VaultQuery envelope
// (bundles carry the same envelope fields as every other vault record).
//
// Optional referential validators — callers can wire in the other stores
// to verify that referenced decisionIds/voteIds/marketSnapshotIds actually
// exist before the bundle is persisted. This closes the "dangling refs"
// gap without forcing cross-subdomain coupling here.
// ═══════════════════════════════════════════════════════════════════════════

export interface ReplayReferenceValidators {
  decisionExists?:        (id: string) => Promise<boolean>;
  voteExists?:            (id: string) => Promise<boolean>;
  marketSnapshotExists?:  (id: string) => Promise<boolean>;
}

export interface ReplayDatasetStorePort {
  append(bundle: ReplayBundle): Promise<void>;
  byTrade(tradeId: TradeId): Promise<ReplayBundle[]>;
  byId(bundleId: string): Promise<ReplayBundle | null>;
  /**
   * `list(query)` filters by the full universal envelope (symbol, session,
   * strategyId, regimeId, agentId, sinceIso, untilIso, limit).
   */
  list(query?: VaultQuery): Promise<ReplayBundle[]>;
}

export function createInMemoryReplayDatasetStore(
  validators: ReplayReferenceValidators = {},
): ReplayDatasetStorePort {
  const bundles = new Map<string, ReplayBundle>();
  return {
    async append(bundle) {
      if (bundles.has(bundle.bundleId)) {
        throw new Error(`bundleId ${bundle.bundleId} already exists — replay bundles are immutable`);
      }
      // Defensive: a bundle with zero references is useless — refuse.
      if (bundle.decisionIds.length === 0
          && bundle.voteIds.length === 0
          && bundle.marketSnapshotIds.length === 0) {
        throw new Error(`bundle ${bundle.bundleId} has no references — refusing empty replay bundle`);
      }
      // Defensive: per-list de-dup so a single bundle can't reference the
      // same id twice and pretend to be richer than it is.
      const dupCheck = (label: string, ids: readonly string[]): void => {
        const seen = new Set<string>();
        for (const id of ids) {
          if (seen.has(id)) throw new Error(`bundle ${bundle.bundleId} duplicate ${label} id ${id}`);
          seen.add(id);
        }
      };
      dupCheck("decisionId",       bundle.decisionIds);
      dupCheck("voteId",           bundle.voteIds);
      dupCheck("marketSnapshotId", bundle.marketSnapshotIds);

      // Optional referential integrity checks — fail-closed if a validator
      // says an id doesn't exist.
      const missing: string[] = [];
      if (validators.decisionExists) {
        for (const id of bundle.decisionIds) {
          if (!(await validators.decisionExists(id))) missing.push(`decisionId:${id}`);
        }
      }
      if (validators.voteExists) {
        for (const id of bundle.voteIds) {
          if (!(await validators.voteExists(id))) missing.push(`voteId:${id}`);
        }
      }
      if (validators.marketSnapshotExists) {
        for (const id of bundle.marketSnapshotIds) {
          if (!(await validators.marketSnapshotExists(id))) missing.push(`marketSnapshotId:${id}`);
        }
      }
      if (missing.length > 0) {
        throw new Error(`bundle ${bundle.bundleId} references missing records: ${missing.join(", ")}`);
      }
      bundles.set(bundle.bundleId, copy(bundle));
    },
    async byTrade(tradeId) {
      return [...bundles.values()]
        .filter((b) => b.tradeId === tradeId)
        .map(copy);
    },
    async byId(bundleId) {
      const b = bundles.get(bundleId);
      return b ? copy(b) : null;
    },
    async list(query) {
      const q = query ?? {};
      const filtered = [...bundles.values()]
        .map(copy)
        .filter((b) => matchesEnvelope(b, q));
      return applyLimit(filtered, q.limit);
    },
  };
}

function copy(b: ReplayBundle): ReplayBundle {
  return {
    ...b,
    decisionIds: [...b.decisionIds],
    voteIds: [...b.voteIds],
    marketSnapshotIds: [...b.marketSnapshotIds],
    reasons: [...b.reasons],
  };
}

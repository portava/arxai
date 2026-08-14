import {
  type DecisionLogEntry, type DecisionId, type VaultQuery,
  matchesEnvelope, applyLimit,
} from "./dataVault.types";

// ═══════════════════════════════════════════════════════════════════════════
// Decision Log Store — every AI decision (signal, approval, block, risk,
// override, mode change, promotion, demotion, evolution). Project rule:
// every AI decision must be stored. This is the canonical decision feed.
//
// Append-only. IDs are unique — re-append of the same decisionId throws to
// prevent silent overwrite of audit history.
// ═══════════════════════════════════════════════════════════════════════════

export interface DecisionLogStorePort {
  append(entry: DecisionLogEntry): Promise<void>;
  list(query?: VaultQuery): Promise<DecisionLogEntry[]>;
  byId(id: DecisionId): Promise<DecisionLogEntry | null>;
}

export function createInMemoryDecisionLogStore(): DecisionLogStorePort {
  const entries: DecisionLogEntry[] = [];
  const ids = new Set<DecisionId>();
  return {
    async append(entry) {
      if (ids.has(entry.decisionId)) {
        throw new Error(`decisionId ${entry.decisionId} already exists — decision log is append-only`);
      }
      ids.add(entry.decisionId);
      entries.push(copy(entry));
    },
    async list(query) {
      const q = query ?? {};
      const filtered = entries.map(copy).filter((e) => matchesEnvelope(e, q));
      return applyLimit(filtered, q.limit);
    },
    async byId(id) {
      const found = entries.find((e) => e.decisionId === id);
      return found ? copy(found) : null;
    },
  };
}

function copy(e: DecisionLogEntry): DecisionLogEntry {
  return { ...e, reasons: [...e.reasons], blockers: [...e.blockers] };
}

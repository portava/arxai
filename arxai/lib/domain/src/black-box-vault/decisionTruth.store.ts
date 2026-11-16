import {
  type DecisionTruthRecord, type DecisionId, type VaultQuery,
  matchesEnvelope, applyLimit,
} from "./blackBox.types";

// ═══════════════════════════════════════════════════════════════════════════
// Decision Truth Store — every AI decision is logged here, including
// BLOCKED ones (verdict: "DENIED"). Project rule: every blocked setup
// must be reviewable. Project rule: every decision traceable.
// ═══════════════════════════════════════════════════════════════════════════

export interface DecisionTruthStorePort {
  append(record: DecisionTruthRecord): Promise<void>;
  list(query?: VaultQuery): Promise<DecisionTruthRecord[]>;
  byId(decisionId: DecisionId): Promise<DecisionTruthRecord | null>;
  /** Decisions that linked to a candidate or executed trade. */
  byTrade(tradeId: string): Promise<DecisionTruthRecord[]>;
  /** Decisions linked to a signal (covers blocked setups). */
  bySignal(signalId: string): Promise<DecisionTruthRecord[]>;
}

export function createInMemoryDecisionTruthStore(): DecisionTruthStorePort {
  const records: DecisionTruthRecord[] = [];
  const ids = new Set<DecisionId>();
  return {
    async append(r) {
      if (ids.has(r.decisionId)) {
        throw new Error(`decisionId ${r.decisionId} already exists — decision truth is append-only`);
      }
      ids.add(r.decisionId);
      records.push(copy(r));
    },
    async list(query) {
      const q = query ?? {};
      const out = records.map(copy).filter((r) => matchesEnvelope(r, q));
      return applyLimit(out, q.limit);
    },
    async byId(id) {
      const r = records.find((x) => x.decisionId === id);
      return r ? copy(r) : null;
    },
    async byTrade(tradeId) {
      return records.filter((r) => r.candidateTradeId === tradeId).map(copy);
    },
    async bySignal(signalId) {
      return records.filter((r) => r.signalId === signalId).map(copy);
    },
  };
}

function copy(r: DecisionTruthRecord): DecisionTruthRecord {
  return {
    ...r,
    votes: r.votes.map((v) => ({ ...v, reasons: [...v.reasons] })),
    reasons: [...r.reasons],
    blockers: [...r.blockers],
  };
}

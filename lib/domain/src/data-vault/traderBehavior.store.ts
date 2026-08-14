import {
  type TraderBehaviorEvent, type TradeId, type VaultQuery,
  matchesEnvelope, applyLimit,
} from "./dataVault.types";

// ═══════════════════════════════════════════════════════════════════════════
// Trader Behaviour Store — every human / operator intervention: risk
// override, block override, manual open / close, mode toggle, parameter
// change, kill-switch press. Project rule: every user override must be
// logged. This is the audit trail for human actions.
// ═══════════════════════════════════════════════════════════════════════════

export interface TraderBehaviorStorePort {
  append(event: TraderBehaviorEvent): Promise<void>;
  list(query?: VaultQuery): Promise<TraderBehaviorEvent[]>;
  byTrade(tradeId: TradeId): Promise<TraderBehaviorEvent[]>;
}

export function createInMemoryTraderBehaviorStore(): TraderBehaviorStorePort {
  const events: TraderBehaviorEvent[] = [];
  const ids = new Set<string>();
  return {
    async append(event) {
      if (ids.has(event.eventId)) {
        throw new Error(`trader behaviour eventId ${event.eventId} already exists — append-only`);
      }
      ids.add(event.eventId);
      events.push(copy(event));
    },
    async list(query) {
      const q = query ?? {};
      const filtered = events.map(copy).filter((e) => matchesEnvelope(e, q));
      return applyLimit(filtered, q.limit);
    },
    async byTrade(tradeId) {
      return events.filter((e) => e.targetTradeId === tradeId).map(copy);
    },
  };
}

function copy(e: TraderBehaviorEvent): TraderBehaviorEvent {
  return { ...e, reasons: [...e.reasons] };
}

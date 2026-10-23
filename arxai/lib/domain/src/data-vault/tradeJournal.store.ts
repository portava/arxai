import {
  type TradeJournalEvent, type VaultQuery, type TradeId,
  matchesEnvelope, applyLimit,
} from "./dataVault.types";

// ═══════════════════════════════════════════════════════════════════════════
// Trade Journal Store — append-only ledger of every trade lifecycle event:
// SIGNAL_CREATED, TRADE_APPROVED, TRADE_BLOCKED, TRADE_EXECUTED,
// TRADE_CLOSED. Project rules:
//   • every blocked trade is logged here (TRADE_BLOCKED kind)
//   • every executed trade is logged here (TRADE_EXECUTED kind)
//   • every close is logged with pnl + close reason (TRADE_CLOSED kind)
// ═══════════════════════════════════════════════════════════════════════════

export interface TradeJournalStorePort {
  append(event: TradeJournalEvent): Promise<void>;
  list(query?: VaultQuery): Promise<TradeJournalEvent[]>;
  /** Return all events for a single trade in the order they were appended. */
  byTrade(tradeId: TradeId): Promise<TradeJournalEvent[]>;
}

export function createInMemoryTradeJournalStore(): TradeJournalStorePort {
  const events: TradeJournalEvent[] = [];
  return {
    async append(event) {
      events.push(deepCopy(event));
    },
    async list(query) {
      const q = query ?? {};
      const filtered = events
        .map(deepCopy)
        .filter((e) => matchesEnvelope(e, q));
      return applyLimit(filtered, q.limit);
    },
    async byTrade(tradeId) {
      return events
        .filter(eventHasTrade(tradeId))
        .map(deepCopy);
    },
  };
}

function eventHasTrade(tradeId: TradeId): (e: TradeJournalEvent) => boolean {
  return (e) => {
    switch (e.kind) {
      case "TRADE_APPROVED":
      case "TRADE_EXECUTED":
      case "TRADE_CLOSED":
        return e.tradeId === tradeId;
      case "TRADE_BLOCKED":
        // Linked via candidateTradeId so blocked attempts surface in the
        // trade's audit trail when the caller assigned a candidate id.
        return e.candidateTradeId === tradeId;
      // SIGNAL_CREATED has no tradeId — exclude (use list() with envelope
      // filters or signalId-based lookups for signals).
      default: return false;
    }
  };
}

function deepCopy<E extends TradeJournalEvent>(e: E): E {
  // Discriminated union — copy reasons / blockers arrays explicitly so
  // mutations to retrieved events don't bleed into the store.
  switch (e.kind) {
    case "SIGNAL_CREATED":
      return { ...e, reasons: [...e.reasons] } as E;
    case "TRADE_APPROVED":
      return { ...e, reasons: [...e.reasons] } as E;
    case "TRADE_BLOCKED":
      return { ...e, reasons: [...e.reasons], blockers: [...e.blockers] } as E;
    case "TRADE_EXECUTED":
      return { ...e, reasons: [...e.reasons] } as E;
    case "TRADE_CLOSED":
      return { ...e, reasons: [...e.reasons] } as E;
  }
}

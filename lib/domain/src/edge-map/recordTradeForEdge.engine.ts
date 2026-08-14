import type {
  EdgeMapStorePort, EdgeTradeRecord,
} from "./edgeMap.types";

// recordTradeForEdge — append a closed-trade record to the edge ledger.
// Idempotent at the store boundary (caller dedupes on tradeId).
export async function recordTradeForEdge(
  store: EdgeMapStorePort,
  trade: EdgeTradeRecord,
): Promise<void> {
  await store.putTrade({ ...trade });
}

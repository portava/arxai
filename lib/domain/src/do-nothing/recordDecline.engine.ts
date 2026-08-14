import type {
  DeclineKind, NoTradeRecord, NoTradeStorePort,
} from "./doNothing.types";

// recordDecline — pure constructor + persist. Caller supplies the
// decline kind (often derived from which gate rejected: governor block,
// judge reject, behavior cooldown, etc).
export async function recordDecline(
  store: NoTradeStorePort,
  args: {
    noTradeId: string;
    symbol: string;
    proposedDirection: "BUY" | "SELL" | null;
    declineKind: DeclineKind;
    declineReasons: string[];
    recordedAt?: string;
  },
): Promise<NoTradeRecord> {
  const record: NoTradeRecord = {
    noTradeId: args.noTradeId,
    recordedAt: args.recordedAt ?? new Date().toISOString(),
    symbol: args.symbol,
    proposedDirection: args.proposedDirection,
    declineKind: args.declineKind,
    declineReasons: args.declineReasons,
  };
  await store.putRecord(record);
  return record;
}

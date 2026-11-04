// The EA wire keys for a mailbox pending order (v1.54 HandlePlacePending /
// HandleCancelPending). The EA reads flat JSON keys from the served row:
// symbol, lot, sl, tp (mt5_commands columns) and orderType, entry,
// stopLimitPrice, expirationEpoch (payload) for a placement; orderTicket for a
// cancel. Same spelling as the live mirror (buildBridgedMt5CommandPayload).
// Draft-side names (entryPrice, stopTriggerPrice, expiration ISO,
// mt5OrderTicket) are kept beside them for the audit trail; the EA ignores them.

function positive(v: unknown): number | null {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
}

export function eaPendingPlacementPayload(draft: {
  orderType: string | null;
  requestedPrice: unknown;
  stopTriggerPrice: unknown;
  stopLimitPrice: unknown;
  expiration: Date | null;
}): Record<string, unknown> {
  const stopLimit = draft.orderType === "BUY_STOP_LIMIT" || draft.orderType === "SELL_STOP_LIMIT";
  // MT5 stop-limit: `price` is the stop trigger, `stoplimit` the limit price.
  const entry = stopLimit
    ? positive(draft.stopTriggerPrice) ?? positive(draft.requestedPrice)
    : positive(draft.requestedPrice);
  const expMs = draft.expiration?.getTime();
  const expirationEpoch = expMs != null && Number.isFinite(expMs) && expMs > 0 ? Math.floor(expMs / 1000) : null;
  const out: Record<string, unknown> = {
    orderType: draft.orderType,
    entryPrice: draft.requestedPrice,
    stopTriggerPrice: draft.stopTriggerPrice,
    stopLimitPrice: draft.stopLimitPrice,
    expiration: draft.expiration?.toISOString() ?? null,
  };
  if (entry != null) out.entry = entry;
  if (stopLimit) {
    const limit = positive(draft.stopLimitPrice);
    if (limit != null) out.stopLimitPrice = limit;
  }
  if (expirationEpoch != null) out.expirationEpoch = expirationEpoch;
  return out;
}

export function eaPendingCancelPayload(mt5OrderTicket: string): Record<string, unknown> {
  return { mt5OrderTicket, orderTicket: mt5OrderTicket };
}

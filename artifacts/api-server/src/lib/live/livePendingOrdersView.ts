// Pure view of the user's working live pending orders (see livePendingOrders.ts
// for what "working" means). No DB import, so it is unit-tested directly.
export const WORKING_PENDING_STATUSES = ["LIVE_FILLED", "LIVE_ACKNOWLEDGED", "LIVE_PARTIALLY_FILLED"] as const;

export type LivePendingCommandRow = {
  commandId: string;
  status: string;
  symbol: string;
  side: string;
  orderType: string;
  requestedVolume: number;
  stopLoss: number | null;
  takeProfit: number | null;
  brokerTicket: string | null;
  payload: unknown;
  createdAt: Date | null;
  resultRecordedAt?: Date | null;
};

export type LivePendingOrderView = {
  commandId: string;
  orderTicket: string;
  symbol: string;
  side: "BUY" | "SELL";
  orderType: string;
  volume: number;
  price: number | null;
  stopLimitPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  expiration: string | null;
  placedAt: string | null;
  stateBasis: "LAST_EA_RESULT";
};

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);

/** Pure: which ledger rows are still working pending orders. */
export function selectWorkingPendingOrders(
  rows: LivePendingCommandRow[],
  positionTickets: ReadonlySet<string>,
  nowMs: number = Date.now(),
): LivePendingOrderView[] {
  const out: LivePendingOrderView[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (!(WORKING_PENDING_STATUSES as readonly string[]).includes(r.status)) continue;
    const ticket = r.brokerTicket?.trim();
    if (!ticket || Number(ticket) === 0 || seen.has(ticket)) continue;
    if (positionTickets.has(ticket)) continue; // filled into a position
    const p = (r.payload ?? {}) as Record<string, unknown>;
    const expEpoch = num(p["expirationEpoch"]);
    if (expEpoch != null && expEpoch * 1000 <= nowMs) continue; // expired at the broker
    seen.add(ticket);
    out.push({
      commandId: r.commandId,
      orderTicket: ticket,
      symbol: r.symbol,
      side: String(r.side).toUpperCase() === "SELL" ? "SELL" : "BUY",
      orderType: r.orderType,
      volume: Number(r.requestedVolume),
      price: num(p["price"]) ?? num(p["entry"]),
      stopLimitPrice: num(p["stopLimitPrice"]),
      stopLoss: r.stopLoss != null && Number(r.stopLoss) > 0 ? Number(r.stopLoss) : null,
      takeProfit: r.takeProfit != null && Number(r.takeProfit) > 0 ? Number(r.takeProfit) : null,
      expiration: expEpoch != null ? new Date(expEpoch * 1000).toISOString() : null,
      placedAt: (r.resultRecordedAt ?? r.createdAt)?.toISOString() ?? null,
      stateBasis: "LAST_EA_RESULT",
    });
  }
  return out;
}


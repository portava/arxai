// Phase TT — Trade Ticket Layered Slice.
//
// One canonical enum for the 8 supported order types. All UI, validation,
// backend routes, AI tools, and audit logs MUST use these exact strings.
// If the EA/bridge ever uses different names, map at the bridge boundary —
// never split the internal vocabulary.

export const ORDER_TYPES = [
  "BUY_MARKET",
  "SELL_MARKET",
  "BUY_LIMIT",
  "SELL_LIMIT",
  "BUY_STOP",
  "SELL_STOP",
  "BUY_STOP_LIMIT",
  "SELL_STOP_LIMIT",
] as const;

export type OrderType = (typeof ORDER_TYPES)[number];

const MARKET_SET: ReadonlySet<OrderType> = new Set(["BUY_MARKET", "SELL_MARKET"]);
const STOP_LIMIT_SET: ReadonlySet<OrderType> = new Set(["BUY_STOP_LIMIT", "SELL_STOP_LIMIT"]);
const BUY_SET: ReadonlySet<OrderType> = new Set([
  "BUY_MARKET", "BUY_LIMIT", "BUY_STOP", "BUY_STOP_LIMIT",
]);

export function isMarketOrder(t: OrderType): boolean { return MARKET_SET.has(t); }
export function isPendingOrder(t: OrderType): boolean { return !MARKET_SET.has(t); }
export function isStopLimit(t: OrderType): boolean { return STOP_LIMIT_SET.has(t); }
export function directionOf(t: OrderType): "BUY" | "SELL" {
  return BUY_SET.has(t) ? "BUY" : "SELL";
}

export function isOrderType(s: unknown): s is OrderType {
  return typeof s === "string" && (ORDER_TYPES as readonly string[]).includes(s);
}

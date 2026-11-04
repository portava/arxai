// MT5 order-type rules for the instant-trade router — pure, no I/O.
//
// MetaTrader 5 semantics (terminal help, "Types of Orders"):
//   Buy  (market)  — buy at the current Ask.
//   Sell (market)  — sell at the current Bid.
//   Buy Limit      — buy when Ask falls to the order price; price must be BELOW the current Ask.
//   Sell Limit     — sell when Bid rises to the order price; price must be ABOVE the current Bid.
//   Buy Stop       — buy when Ask rises to the order price; price must be ABOVE the current Ask.
//   Sell Stop      — sell when Bid falls to the order price; price must be BELOW the current Bid.
//   Buy Stop Limit — when Ask reaches the stop price, a Buy Limit is placed at the stop-limit
//                    price (stop ABOVE Ask, limit BELOW stop).
//   Sell Stop Limit— when Bid reaches the stop price, a Sell Limit is placed at the stop-limit
//                    price (stop BELOW Bid, limit ABOVE stop).
//   Stop Loss / Take Profit — Buy: SL below, TP above; Sell: SL above, TP below.
//   Expiration     — GTC when none is given, otherwise a specified time (ORDER_TIME_SPECIFIED).
//
// The broker enforces its own stops/freeze levels at the terminal; these rules
// catch the wrong-side mistakes before a command is drafted so a user never
// pays a gate round-trip for an order MT5 would reject anyway.

export type OrderKind = "MARKET" | "LIMIT" | "STOP" | "STOP_LIMIT";
export type OrderSide = "BUY" | "SELL";

export interface ClassifiedOrderType {
  /** Canonical live-pipeline vocabulary: MARKET_BUY | MARKET_SELL | BUY_LIMIT | SELL_LIMIT | BUY_STOP | SELL_STOP | BUY_STOP_LIMIT | SELL_STOP_LIMIT */
  canonical: string;
  kind: OrderKind;
  side: OrderSide;
  pending: boolean;
}

const CANON: Record<string, ClassifiedOrderType> = {
  MARKET_BUY: { canonical: "MARKET_BUY", kind: "MARKET", side: "BUY", pending: false },
  BUY_MARKET: { canonical: "MARKET_BUY", kind: "MARKET", side: "BUY", pending: false },
  MARKET_SELL: { canonical: "MARKET_SELL", kind: "MARKET", side: "SELL", pending: false },
  SELL_MARKET: { canonical: "MARKET_SELL", kind: "MARKET", side: "SELL", pending: false },
  BUY_LIMIT: { canonical: "BUY_LIMIT", kind: "LIMIT", side: "BUY", pending: true },
  SELL_LIMIT: { canonical: "SELL_LIMIT", kind: "LIMIT", side: "SELL", pending: true },
  BUY_STOP: { canonical: "BUY_STOP", kind: "STOP", side: "BUY", pending: true },
  SELL_STOP: { canonical: "SELL_STOP", kind: "STOP", side: "SELL", pending: true },
  BUY_STOP_LIMIT: { canonical: "BUY_STOP_LIMIT", kind: "STOP_LIMIT", side: "BUY", pending: true },
  SELL_STOP_LIMIT: { canonical: "SELL_STOP_LIMIT", kind: "STOP_LIMIT", side: "SELL", pending: true },
};

/** Normalise any accepted spelling ("buy limit", "BUY_LIMIT", "Buy-Limit") to the canonical type. */
export function classifyOrderType(raw: string | null | undefined, fallbackSide: OrderSide): ClassifiedOrderType {
  const key = String(raw ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (!key) return CANON[fallbackSide === "BUY" ? "MARKET_BUY" : "MARKET_SELL"]!;
  return CANON[key] ?? { canonical: key, kind: "MARKET", side: fallbackSide, pending: !/MARKET/.test(key) };
}

export function isKnownOrderType(raw: string | null | undefined): boolean {
  const key = String(raw ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  return key in CANON;
}

export type PendingPriceCheck =
  | { ok: true }
  | { ok: false; code: "MISSING_PENDING_PRICE" | "MISSING_STOP_LIMIT_PRICE" | "PENDING_PRICE_WRONG_SIDE" | "STOP_LIMIT_PRICE_WRONG_SIDE" | "ORDER_TYPE_SIDE_MISMATCH" | "UNKNOWN_ORDER_TYPE"; detail: string };

/**
 * Check a pending order's price against the current bid/ask the way MT5 does.
 * When bid/ask are unknown (null) the side check is skipped — the broker still
 * enforces it — but a missing price is always refused.
 */
export function validatePendingOrder(args: {
  orderType: string;
  action: OrderSide;
  price: number | null | undefined;
  stopLimitPrice?: number | null;
  bid: number | null;
  ask: number | null;
}): PendingPriceCheck {
  if (!isKnownOrderType(args.orderType)) {
    return { ok: false, code: "UNKNOWN_ORDER_TYPE", detail: `Order type '${args.orderType}' is not one of MT5's order types.` };
  }
  const t = classifyOrderType(args.orderType, args.action);
  if (t.side !== args.action) {
    return { ok: false, code: "ORDER_TYPE_SIDE_MISMATCH", detail: `${t.canonical} is a ${t.side} order but the action is ${args.action}.` };
  }
  if (!t.pending) return { ok: true };
  const price = args.price;
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
    return { ok: false, code: "MISSING_PENDING_PRICE", detail: `${label(t.canonical)} needs the price it should trigger at.` };
  }
  const { bid, ask } = args;
  const have = (n: number | null): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;
  if (t.kind === "LIMIT" || t.kind === "STOP" || t.kind === "STOP_LIMIT") {
    // The trigger leg: limit = better than market, stop = worse than market.
    if (t.side === "BUY" && have(ask)) {
      const mustBeBelow = t.kind === "LIMIT";
      if (mustBeBelow ? price >= ask : price <= ask) {
        return { ok: false, code: "PENDING_PRICE_WRONG_SIDE", detail: `${label(t.canonical)} must be ${mustBeBelow ? "below" : "above"} the current Ask ${ask}.` };
      }
    }
    if (t.side === "SELL" && have(bid)) {
      const mustBeAbove = t.kind === "LIMIT";
      if (mustBeAbove ? price <= bid : price >= bid) {
        return { ok: false, code: "PENDING_PRICE_WRONG_SIDE", detail: `${label(t.canonical)} must be ${mustBeAbove ? "above" : "below"} the current Bid ${bid}.` };
      }
    }
  }
  if (t.kind === "STOP_LIMIT") {
    const sl = args.stopLimitPrice;
    if (typeof sl !== "number" || !Number.isFinite(sl) || sl <= 0) {
      return { ok: false, code: "MISSING_STOP_LIMIT_PRICE", detail: `${label(t.canonical)} needs the limit price placed once the stop price is reached.` };
    }
    // Buy Stop Limit: limit below the stop. Sell Stop Limit: limit above the stop.
    if (t.side === "BUY" ? sl >= price : sl <= price) {
      return { ok: false, code: "STOP_LIMIT_PRICE_WRONG_SIDE", detail: t.side === "BUY" ? "Buy Stop Limit: the limit price must be below the stop price." : "Sell Stop Limit: the limit price must be above the stop price." };
    }
  }
  return { ok: true };
}

export type ProtectionCheck =
  | { ok: true }
  | { ok: false; code: "STOP_LOSS_WRONG_SIDE" | "TAKE_PROFIT_WRONG_SIDE"; detail: string };

/**
 * SL/TP side rule (MT5): Buy → SL below the reference, TP above. Sell → SL above,
 * TP below. The reference is the pending price for a pending order, else the
 * market price (bid for a Buy's exit, ask for a Sell's exit) when known.
 */
export function validateProtection(args: {
  side: OrderSide;
  reference: number | null;
  stopLoss?: number | null;
  takeProfit?: number | null;
}): ProtectionCheck {
  const ref = args.reference;
  if (typeof ref !== "number" || !Number.isFinite(ref) || ref <= 0) return { ok: true };
  const sl = args.stopLoss, tp = args.takeProfit;
  const has = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;
  if (has(sl) && (args.side === "BUY" ? sl >= ref : sl <= ref)) {
    return { ok: false, code: "STOP_LOSS_WRONG_SIDE", detail: args.side === "BUY" ? `Stop loss ${sl} must be below ${ref} for a Buy.` : `Stop loss ${sl} must be above ${ref} for a Sell.` };
  }
  if (has(tp) && (args.side === "BUY" ? tp <= ref : tp >= ref)) {
    return { ok: false, code: "TAKE_PROFIT_WRONG_SIDE", detail: args.side === "BUY" ? `Take profit ${tp} must be above ${ref} for a Buy.` : `Take profit ${tp} must be below ${ref} for a Sell.` };
  }
  return { ok: true };
}

/** ISO expiration → epoch seconds for the EA (ORDER_TIME_SPECIFIED); null/invalid/past → null (GTC). */
export function expirationEpochSeconds(iso: string | null | undefined, nowMs: number = Date.now()): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t) || t <= nowMs) return null;
  return Math.floor(t / 1000);
}

export function label(canonical: string): string {
  const m = /^MARKET_(BUY|SELL)$/.exec(canonical);
  if (m) return `${m[1]} by Market`;
  return canonical.split("_").map((w) => w[0] + w.slice(1).toLowerCase()).join(" ");
}

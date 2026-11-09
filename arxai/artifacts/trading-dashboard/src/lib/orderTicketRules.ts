// MT5 order-ticket rules for the dashboard — pure, mirrors the server's
// lib/live/pendingOrderRules.ts so a wrong-side order is caught before a click
// costs a round trip. The server re-checks everything.
//
// MetaTrader 5 order types (terminal help → "Types of Orders"):
//   Buy / Sell (market)   — at the current Ask / Bid.
//   Buy Limit             — below the current Ask; fills when Ask falls to it.
//   Sell Limit            — above the current Bid; fills when Bid rises to it.
//   Buy Stop              — above the current Ask; fills when Ask rises to it.
//   Sell Stop             — below the current Bid; fills when Bid falls to it.
//   Buy Stop Limit        — stop above Ask, then a Buy Limit at a lower limit price.
//   Sell Stop Limit       — stop below Bid, then a Sell Limit at a higher limit price.
//   Stop Loss / Take Profit — Buy: SL below, TP above; Sell: SL above, TP below.
//   Expiration            — GTC, or a specified time.

export type OrderTypeId =
  | "MARKET_BUY" | "MARKET_SELL"
  | "BUY_LIMIT" | "SELL_LIMIT" | "BUY_STOP" | "SELL_STOP"
  | "BUY_STOP_LIMIT" | "SELL_STOP_LIMIT";

export type OrderSide = "BUY" | "SELL";
export type OrderKind = "MARKET" | "LIMIT" | "STOP" | "STOP_LIMIT";

export interface OrderTypeInfo {
  id: OrderTypeId;
  side: OrderSide;
  kind: OrderKind;
  /** MT5 button wording. */
  label: string;
  /** One line, MT5 semantics. */
  hint: string;
}

export const ORDER_TYPE_INFO: readonly OrderTypeInfo[] = [
  { id: "MARKET_BUY", side: "BUY", kind: "MARKET", label: "Buy by Market", hint: "Buy now at the Ask." },
  { id: "MARKET_SELL", side: "SELL", kind: "MARKET", label: "Sell by Market", hint: "Sell now at the Bid." },
  { id: "BUY_LIMIT", side: "BUY", kind: "LIMIT", label: "Buy Limit", hint: "Buy when the Ask falls to your price (price below the Ask)." },
  { id: "SELL_LIMIT", side: "SELL", kind: "LIMIT", label: "Sell Limit", hint: "Sell when the Bid rises to your price (price above the Bid)." },
  { id: "BUY_STOP", side: "BUY", kind: "STOP", label: "Buy Stop", hint: "Buy when the Ask rises to your price (price above the Ask)." },
  { id: "SELL_STOP", side: "SELL", kind: "STOP", label: "Sell Stop", hint: "Sell when the Bid falls to your price (price below the Bid)." },
  { id: "BUY_STOP_LIMIT", side: "BUY", kind: "STOP_LIMIT", label: "Buy Stop Limit", hint: "When the Ask reaches the stop price, place a Buy Limit at the limit price (below the stop)." },
  { id: "SELL_STOP_LIMIT", side: "SELL", kind: "STOP_LIMIT", label: "Sell Stop Limit", hint: "When the Bid reaches the stop price, place a Sell Limit at the limit price (above the stop)." },
];

export function orderTypeInfo(id: OrderTypeId): OrderTypeInfo {
  return ORDER_TYPE_INFO.find((o) => o.id === id)!;
}

export function isPendingType(id: OrderTypeId): boolean {
  return orderTypeInfo(id).kind !== "MARKET";
}

export type ExpirationChoice = "GTC" | "TODAY" | "SPECIFIED";

export interface TicketDraft {
  orderType: OrderTypeId;
  lot: number | null;
  /** Pending trigger price (limit/stop) — the price the order is placed at. */
  price: number | null;
  /** Stop-limit only: the limit leg's price. */
  stopLimitPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  expiration: ExpirationChoice;
  /** ISO datetime for SPECIFIED. */
  expiresAt: string | null;
  /**
   * The trader's own bridge broker clock − UTC, in ms (GET /api/me/broker-clock).
   * Sets where "Today" ends; null/absent = unknown (23:59 UTC).
   */
  brokerClockOffsetMs?: number | null;
}

export interface TicketQuote { bid: number | null; ask: number | null }

export interface TicketValidation {
  ok: boolean;
  /** First error is the one to show on the button. */
  errors: string[];
  /** Reference price used for SL/TP side checks (pending price or market side). */
  reference: number | null;
  riskReward: number | null;
}

const fin = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

/** Broker symbol rules, when the EA has enumerated them (all optional). */
export interface TicketSymbolSpec {
  volumeMin?: number | null;
  volumeStep?: number | null;
  volumeMax?: number | null;
  point?: number | null;
  /** SYMBOL_TRADE_STOPS_LEVEL in points: minimum SL/TP distance from the reference. */
  stopsLevel?: number | null;
}

export function validateTicket(d: TicketDraft, q: TicketQuote, spec?: TicketSymbolSpec | null): TicketValidation {
  const errors: string[] = [];
  const info = orderTypeInfo(d.orderType);
  if (!fin(d.lot)) errors.push("Enter a lot size above 0.");
  else {
    if (fin(spec?.volumeMin) && d.lot < spec!.volumeMin! - 1e-9) errors.push(`The smallest lot for this symbol is ${spec!.volumeMin}.`);
    if (fin(spec?.volumeMax) && d.lot > spec!.volumeMax! + 1e-9) errors.push(`The largest lot for this symbol is ${spec!.volumeMax}.`);
    if (fin(spec?.volumeStep)) {
      const k = d.lot / spec!.volumeStep!;
      if (Math.abs(k - Math.round(k)) > 1e-6) errors.push(`Lot must be a multiple of ${spec!.volumeStep}.`);
    }
  }

  let reference: number | null = null;
  if (info.kind === "MARKET") {
    reference = info.side === "BUY" ? q.bid ?? q.ask : q.ask ?? q.bid; // exit side for SL/TP checks
  } else {
    if (!fin(d.price)) errors.push(`${info.label} needs a price.`);
    else {
      const ask = q.ask, bid = q.bid;
      if (info.side === "BUY" && fin(ask)) {
        if (info.kind === "LIMIT" && d.price >= ask) errors.push(`Buy Limit price must be below the Ask (${ask}).`);
        if ((info.kind === "STOP" || info.kind === "STOP_LIMIT") && d.price <= ask) errors.push(`${info.label} price must be above the Ask (${ask}).`);
      }
      if (info.side === "SELL" && fin(bid)) {
        if (info.kind === "LIMIT" && d.price <= bid) errors.push(`Sell Limit price must be above the Bid (${bid}).`);
        if ((info.kind === "STOP" || info.kind === "STOP_LIMIT") && d.price >= bid) errors.push(`${info.label} price must be below the Bid (${bid}).`);
      }
      reference = d.price;
    }
    if (info.kind === "STOP_LIMIT") {
      if (!fin(d.stopLimitPrice)) errors.push(`${info.label} needs the limit price.`);
      else if (fin(d.price)) {
        if (info.side === "BUY" && d.stopLimitPrice >= d.price) errors.push("Buy Stop Limit: the limit price must be below the stop price.");
        if (info.side === "SELL" && d.stopLimitPrice <= d.price) errors.push("Sell Stop Limit: the limit price must be above the stop price.");
        reference = d.stopLimitPrice;
      }
    }
    if (d.expiration === "SPECIFIED") {
      const t = d.expiresAt ? Date.parse(d.expiresAt) : NaN;
      if (!Number.isFinite(t)) errors.push("Pick an expiry date and time.");
      else if (t <= Date.now()) errors.push("Expiry must be in the future.");
    }
    if (d.expiration === "TODAY") {
      const iso = expirationIso(d);
      if (iso && Date.parse(iso) <= Date.now()) errors.push("Today's trading day has ended. Pick a time or use GTC.");
    }
  }

  if (fin(reference)) {
    if (fin(d.stopLoss) && (info.side === "BUY" ? d.stopLoss >= reference : d.stopLoss <= reference)) {
      errors.push(info.side === "BUY" ? "Stop Loss must be below the price for a Buy." : "Stop Loss must be above the price for a Sell.");
    }
    if (fin(d.takeProfit) && (info.side === "BUY" ? d.takeProfit <= reference : d.takeProfit >= reference)) {
      errors.push(info.side === "BUY" ? "Take Profit must be above the price for a Buy." : "Take Profit must be below the price for a Sell.");
    }
  }

  // Broker stops level: SL/TP at least stopsLevel points from the reference.
  if (fin(reference) && fin(spec?.stopsLevel) && fin(spec?.point)) {
    const minDist = spec!.stopsLevel! * spec!.point!;
    if (fin(d.stopLoss) && Math.abs(reference - d.stopLoss) < minDist - 1e-12) errors.push(`Stop Loss must be at least ${spec!.stopsLevel} points from the price (broker stops level).`);
    if (fin(d.takeProfit) && Math.abs(d.takeProfit - reference) < minDist - 1e-12) errors.push(`Take Profit must be at least ${spec!.stopsLevel} points from the price (broker stops level).`);
  }

  let riskReward: number | null = null;
  if (fin(reference) && fin(d.stopLoss) && fin(d.takeProfit)) {
    const risk = Math.abs(reference - d.stopLoss), reward = Math.abs(d.takeProfit - reference);
    riskReward = risk > 0 ? Math.round((reward / risk) * 100) / 100 : null;
  }
  return { ok: errors.length === 0, errors, reference, riskReward };
}

/**
 * The UTC instant at which the BROKER's current trading day ends.
 *
 * MT5's "Today" pending-order expiry is the broker's calendar day. With the
 * broker clock − UTC offset (ms) known, the day ends 23:59:59 broker time,
 * converted back to UTC (the EAs take a UTC epoch and convert to server time
 * on their side). Unknown offset: 23:59 UTC, as before.
 */
export function brokerDayEndIso(nowMs: number, brokerClockOffsetMs: number | null | undefined): string {
  const known = typeof brokerClockOffsetMs === "number" && Number.isFinite(brokerClockOffsetMs);
  if (!known) {
    const d = new Date(nowMs);
    d.setUTCHours(23, 59, 0, 0);
    return d.toISOString();
  }
  const broker = new Date(nowMs + brokerClockOffsetMs);
  broker.setUTCHours(23, 59, 59, 0);
  return new Date(broker.getTime() - brokerClockOffsetMs).toISOString();
}

/** Resolve the expiration choice to the ISO string the server takes (null = GTC). */
//
// "Today" = end of the BROKER's day (brokerDayEndIso). The offset comes from
// the explicit minutes argument when given, else the draft's
// brokerClockOffsetMs (the order window fills it from useBrokerClockOffset).
export function expirationIso(d: Pick<TicketDraft, "expiration" | "expiresAt" | "brokerClockOffsetMs">, now: Date = new Date(), brokerUtcOffsetMinutes: number | null = null): string | null {
  if (d.expiration === "GTC") return null;
  if (d.expiration === "TODAY") {
    const offMs = typeof brokerUtcOffsetMinutes === "number" && Number.isFinite(brokerUtcOffsetMinutes)
      ? brokerUtcOffsetMinutes * 60_000
      : d.brokerClockOffsetMs ?? null;
    return brokerDayEndIso(now.getTime(), offMs);
  }
  return d.expiresAt && Number.isFinite(Date.parse(d.expiresAt)) ? new Date(d.expiresAt).toISOString() : null;
}

/** Validate a change of an open position's SL/TP (MT5: Buy SL below / TP above current Bid; Sell the reverse against Ask). */
export function validateModify(args: { side: OrderSide; reference: number | null; newStopLoss: number | null; newTakeProfit: number | null }): { ok: boolean; error: string | null } {
  const { side, reference, newStopLoss: sl, newTakeProfit: tp } = args;
  if (!fin(sl) && !fin(tp)) return { ok: false, error: "Enter a new Stop Loss or Take Profit." };
  if (!fin(reference)) return { ok: true, error: null }; // broker enforces
  if (fin(sl) && (side === "BUY" ? sl >= reference : sl <= reference)) return { ok: false, error: side === "BUY" ? "Stop Loss must be below the current price for a Buy." : "Stop Loss must be above the current price for a Sell." };
  if (fin(tp) && (side === "BUY" ? tp <= reference : tp >= reference)) return { ok: false, error: side === "BUY" ? "Take Profit must be above the current price for a Buy." : "Take Profit must be below the current price for a Sell." };
  return { ok: true, error: null };
}

export function parseNum(raw: string): number | null {
  const t = raw.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Resolve what an SL/TP edit actually sends, per scope.
 *
 *  - An EMPTY field means "leave it as it is" on both scopes:
 *      live → null; the server keeps the position's current level
 *             (`newStopLoss ?? row.stopLoss`) and the EA reads 0 as "leave".
 *      demo → the position's CURRENT level; the demo EA applies exactly what it
 *             is sent, so a missing level would REMOVE the stop.
 *  - "Remove" sends 0 (no stop / no target). Only the demo terminal can express
 *    removal: the live EA (v154 HandleModifyProtection) reads 0 as "leave as
 *    is", so removal is not offered on live (`removalSupported`).
 *  - The side check runs only against a known current price; with no current
 *    price the broker enforces it (the entry price is not the reference).
 */
export function resolveModifyLevels(a: {
  scope: "live" | "demo";
  side: OrderSide;
  currentPrice: number | null;
  current: { stopLoss: number | null; takeProfit: number | null };
  slText: string;
  tpText: string;
  removeSl?: boolean;
  removeTp?: boolean;
}): { newStopLoss: number | null; newTakeProfit: number | null; error: string | null; unchanged: boolean } {
  const removalSupported = a.scope === "demo";
  const removeSl = removalSupported && a.removeSl === true;
  const removeTp = removalSupported && a.removeTp === true;
  const typedSl = removeSl ? null : parseNum(a.slText);
  const typedTp = removeTp ? null : parseNum(a.tpText);
  if (!removeSl && a.slText.trim() !== "" && typedSl == null) return { newStopLoss: null, newTakeProfit: null, error: "Stop Loss must be a price above 0.", unchanged: false };
  if (!removeTp && a.tpText.trim() !== "" && typedTp == null) return { newStopLoss: null, newTakeProfit: null, error: "Take Profit must be a price above 0.", unchanged: false };
  const curSl = fin(a.current.stopLoss) ? a.current.stopLoss : null;
  const curTp = fin(a.current.takeProfit) ? a.current.takeProfit : null;
  const effSl = removeSl ? null : typedSl ?? curSl;
  const effTp = removeTp ? null : typedTp ?? curTp;
  const unchanged = effSl === curSl && effTp === curTp;
  if (unchanged) return { newStopLoss: null, newTakeProfit: null, error: "Change the Stop Loss or Take Profit first.", unchanged: true };
  const ref = fin(a.currentPrice) ? a.currentPrice : null;
  if (ref != null) {
    const v = validateModify({ side: a.side, reference: ref, newStopLoss: typedSl, newTakeProfit: typedTp });
    if (!v.ok && (typedSl != null || typedTp != null)) return { newStopLoss: null, newTakeProfit: null, error: v.error, unchanged: false };
  }
  if (a.scope === "live") return { newStopLoss: typedSl, newTakeProfit: typedTp, error: null, unchanged: false };
  return { newStopLoss: removeSl ? 0 : effSl ?? 0, newTakeProfit: removeTp ? 0 : effTp ?? 0, error: null, unchanged: false };
}

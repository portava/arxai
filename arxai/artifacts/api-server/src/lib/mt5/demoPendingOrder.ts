// Demo pending orders — pure payload contract (no I/O).
//
// A PLACE_PENDING_ORDER demo command reaches ReplitMT5BridgeEA v1.32, whose
// ExecuteDemoRequest reads `orderType`, `entry` (fallback `price`),
// `stopLimitPrice` and `expirationEpoch` (UTC seconds; the EA converts to
// trade-server time). CANCEL_PENDING_ORDER carries the order's ticket as a
// decimal string in `orderTicket` (and `ticket`, the EA's fallback key).
//
// The server's MT5 order rules (lib/live/pendingOrderRules.ts) are the
// authority: the type must be a real MT5 pending type, the stop-limit leg must
// sit on the right side of the stop, and SL/TP must be on the right side of the
// reference price. No bid/ask is known here, so the market-side check is left
// to the broker, exactly as on the live path when no quote is available.

import {
  classifyOrderType,
  isKnownOrderType,
  validatePendingOrder,
  validateProtection,
} from "../live/pendingOrderRules.js";

export type DemoPendingNormalised =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; reason: string };

const pos = (v: unknown): number | null => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
};

/** Decimal ticket string, or null. Never a float, never a negative. */
export function ticketString(v: unknown): string | null {
  if (typeof v === "number" && Number.isSafeInteger(v) && v > 0) return String(v);
  if (typeof v === "string" && /^[1-9]\d{0,17}$/.test(v.trim())) return v.trim();
  return null;
}

/**
 * Validate and canonicalise a PLACE_PENDING_ORDER payload. Returns the payload
 * with `orderType` canonical, `side` derived from it, `price` and `entry`
 * mirrored, and `stopLimitPrice` / `expirationEpoch` present only when set.
 */
export function normaliseDemoPendingPayload(
  payload: Record<string, unknown>,
  nowMs: number = Date.now(),
): DemoPendingNormalised {
  const rawType = typeof payload["orderType"] === "string" ? payload["orderType"] : "";
  if (!isKnownOrderType(rawType)) return { ok: false, reason: "PENDING_ORDER_TYPE_REQUIRED" };
  const sideRaw = String(payload["side"] ?? "").toUpperCase();
  const fallbackSide = sideRaw === "SELL" ? "SELL" : "BUY";
  const t = classifyOrderType(rawType, fallbackSide);
  if (!t.pending) return { ok: false, reason: "PENDING_ORDER_TYPE_REQUIRED" };
  if ((sideRaw === "BUY" || sideRaw === "SELL") && sideRaw !== t.side) {
    return { ok: false, reason: "ORDER_TYPE_SIDE_MISMATCH" };
  }
  const entry = pos(payload["entry"]) ?? pos(payload["price"]);
  const stopLimit = pos(payload["stopLimitPrice"]);
  const check = validatePendingOrder({
    orderType: t.canonical, action: t.side, price: entry, stopLimitPrice: stopLimit, bid: null, ask: null,
  });
  if (!check.ok) return { ok: false, reason: check.code };
  const reference = t.kind === "STOP_LIMIT" ? stopLimit : entry;
  const protection = validateProtection({
    side: t.side, reference,
    stopLoss: pos(payload["stopLoss"]), takeProfit: pos(payload["takeProfit"]),
  });
  if (!protection.ok) return { ok: false, reason: protection.code };

  let expirationEpoch: number | null = null;
  const expRaw = payload["expirationEpoch"];
  if (expRaw != null && expRaw !== "") {
    const exp = pos(expRaw);
    if (exp == null) return { ok: false, reason: "INVALID_EXPIRATION" };
    if (exp * 1000 <= nowMs) return { ok: false, reason: "EXPIRATION_IN_PAST" };
    expirationEpoch = Math.floor(exp);
  } else if (typeof payload["expiration"] === "string" && payload["expiration"]) {
    const ms = Date.parse(payload["expiration"]);
    if (!Number.isFinite(ms)) return { ok: false, reason: "INVALID_EXPIRATION" };
    if (ms <= nowMs) return { ok: false, reason: "EXPIRATION_IN_PAST" };
    expirationEpoch = Math.floor(ms / 1000);
  }

  const out: Record<string, unknown> = { ...payload };
  delete out["stopLimitPrice"];
  delete out["expirationEpoch"];
  out["orderType"] = t.canonical;
  out["side"] = t.side;
  out["price"] = entry;
  out["entry"] = entry;
  if (t.kind === "STOP_LIMIT") out["stopLimitPrice"] = stopLimit;
  if (expirationEpoch != null) out["expirationEpoch"] = expirationEpoch;
  return { ok: true, payload: out };
}

/** The ticket a CANCEL_PENDING_ORDER payload names (orderTicket, then ticket). */
export function cancelPendingTicket(payload: Record<string, unknown>): string | null {
  return ticketString(payload["orderTicket"]) ?? ticketString(payload["ticket"]);
}

/** EA-facing pending fields for a PLACE_PENDING_ORDER built by the trade pipeline. */
export function demoPendingFields(p: {
  orderType: string; price: number; stopLimitPrice?: number | null; expirationEpoch?: number | null;
}): Record<string, unknown> {
  return {
    orderType: p.orderType,
    price: p.price,
    entry: p.price,
    ...(pos(p.stopLimitPrice) != null ? { stopLimitPrice: p.stopLimitPrice } : {}),
    ...(pos(p.expirationEpoch) != null ? { expirationEpoch: Math.floor(p.expirationEpoch!) } : {}),
  };
}

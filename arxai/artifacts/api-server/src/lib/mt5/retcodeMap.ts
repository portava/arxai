// T033 Phase 8 — MT5 trade-server return-code mapping.
//
// Maps the raw integer retcode the MT5 server returns (TRADE_RETCODE_*) into a
// stable category + a short technical label. The category feeds the structured
// rejection display; the raw code is always preserved alongside for admin view.
//
// Source: MT5 TRADE_RETCODE_* constants. We map the ones that actually occur on
// live order placement; anything unmapped → "unknown_broker_response" (never
// guessed, never silently treated as success).

export type RetcodeCategory =
  | "filled"
  | "accepted"
  | "rejected_by_broker"
  | "invalid_symbol"
  | "invalid_lot_size"
  | "invalid_stops"
  | "insufficient_margin"
  | "market_closed"
  | "requote_price_changed"
  | "trade_disabled"
  | "timeout"
  | "expired_unclaimed"
  | "unknown_broker_response";

export interface RetcodeInfo {
  retcode: number;
  category: RetcodeCategory;
  /** Short technical label (admin-facing). */
  label: string;
  /** True only for codes that mean the order actually went on (done/placed). */
  isSuccess: boolean;
}

// MT5 TRADE_RETCODE_* → category. Numbers are the platform constants.
const RETCODE_MAP: Record<number, { category: RetcodeCategory; label: string; isSuccess: boolean }> = {
  10009: { category: "filled", label: "TRADE_RETCODE_DONE — request completed", isSuccess: true },
  10008: { category: "accepted", label: "TRADE_RETCODE_PLACED — order placed", isSuccess: true },
  10010: { category: "filled", label: "TRADE_RETCODE_DONE_PARTIAL — partially filled", isSuccess: true },

  10004: { category: "requote_price_changed", label: "TRADE_RETCODE_REQUOTE", isSuccess: false },
  10006: { category: "rejected_by_broker", label: "TRADE_RETCODE_REJECT — request rejected", isSuccess: false },
  10007: { category: "rejected_by_broker", label: "TRADE_RETCODE_CANCEL — cancelled by trader", isSuccess: false },
  10011: { category: "rejected_by_broker", label: "TRADE_RETCODE_ERROR — request processing error", isSuccess: false },
  10012: { category: "timeout", label: "TRADE_RETCODE_TIMEOUT — request cancelled by timeout", isSuccess: false },
  10013: { category: "rejected_by_broker", label: "TRADE_RETCODE_INVALID — invalid request", isSuccess: false },
  10014: { category: "invalid_lot_size", label: "TRADE_RETCODE_INVALID_VOLUME", isSuccess: false },
  10015: { category: "requote_price_changed", label: "TRADE_RETCODE_INVALID_PRICE", isSuccess: false },
  10016: { category: "invalid_stops", label: "TRADE_RETCODE_INVALID_STOPS", isSuccess: false },
  10017: { category: "trade_disabled", label: "TRADE_RETCODE_TRADE_DISABLED", isSuccess: false },
  10018: { category: "market_closed", label: "TRADE_RETCODE_MARKET_CLOSED", isSuccess: false },
  10019: { category: "insufficient_margin", label: "TRADE_RETCODE_NO_MONEY — insufficient funds", isSuccess: false },
  10020: { category: "requote_price_changed", label: "TRADE_RETCODE_PRICE_CHANGED", isSuccess: false },
  10021: { category: "requote_price_changed", label: "TRADE_RETCODE_PRICE_OFF — no quotes", isSuccess: false },
  10022: { category: "invalid_stops", label: "TRADE_RETCODE_INVALID_EXPIRATION", isSuccess: false },
  10024: { category: "rejected_by_broker", label: "TRADE_RETCODE_TOO_MANY_REQUESTS", isSuccess: false },
  10026: { category: "trade_disabled", label: "TRADE_RETCODE_SERVER_DISABLES_AT — autotrading disabled by server", isSuccess: false },
  10027: { category: "trade_disabled", label: "TRADE_RETCODE_CLIENT_DISABLES_AT — autotrading disabled by client", isSuccess: false },
  10028: { category: "rejected_by_broker", label: "TRADE_RETCODE_LOCKED — request locked", isSuccess: false },
  10029: { category: "rejected_by_broker", label: "TRADE_RETCODE_FROZEN — order/position frozen", isSuccess: false },
  10030: { category: "invalid_lot_size", label: "TRADE_RETCODE_INVALID_FILL — unsupported filling mode", isSuccess: false },
  10031: { category: "timeout", label: "TRADE_RETCODE_CONNECTION — no connection to server", isSuccess: false },
  10033: { category: "invalid_lot_size", label: "TRADE_RETCODE_LIMIT_ORDERS — order limit reached", isSuccess: false },
  10034: { category: "invalid_lot_size", label: "TRADE_RETCODE_LIMIT_VOLUME — volume limit reached", isSuccess: false },
  10036: { category: "rejected_by_broker", label: "TRADE_RETCODE_POSITION_CLOSED", isSuccess: false },
};

export function classifyRetcode(retcode: number | null | undefined): RetcodeInfo {
  if (retcode == null || !Number.isFinite(retcode)) {
    return { retcode: NaN, category: "unknown_broker_response", label: "no retcode reported", isSuccess: false };
  }
  const hit = RETCODE_MAP[retcode];
  if (!hit) {
    return { retcode, category: "unknown_broker_response", label: `unmapped MT5 retcode ${retcode}`, isSuccess: false };
  }
  return { retcode, category: hit.category, label: hit.label, isSuccess: hit.isSuccess };
}

/** True only for retcodes that mean the order actually executed/placed. */
export function isSuccessRetcode(retcode: number | null | undefined): boolean {
  return classifyRetcode(retcode).isSuccess;
}

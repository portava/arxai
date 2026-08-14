// Task #30 — Central MT5 trade-server retcode dictionary.
//
// PURPOSE: the EA reports a raw MT5 retcode (e.g. 10027) on every order result.
// Raw numbers mean nothing to a user. This module maps each known retcode to a
// stable key + a clear, non-technical ARX message. Raw codes / broker comments
// stay behind admin diagnostics; the user only ever sees `friendly`.
//
// SAFETY: pure data + lookup. No IO. Used to DERIVE a friendly rejectionReason
// for storage/UI — it never changes whether a command succeeded or what gate
// decided it. Unknown codes fall back to a generic, honest message.

export interface Mt5RetcodeEntry {
  /** Stable machine key (admin/diagnostics + grep). */
  key: string;
  /** User-facing, non-technical explanation. */
  friendly: string;
  /** True when the condition is typically transient and worth retrying later. */
  transient: boolean;
}

// Codes from the MQL5 TRADE_RETCODE_* constants. Only the ones that actually
// reach a live/demo order result are mapped; the rest fall through to generic.
const RETCODES: Record<number, Mt5RetcodeEntry> = {
  10004: { key: "REQUOTE", friendly: "The broker requoted the price. The trade was not placed.", transient: true },
  10006: { key: "REQUEST_REJECTED", friendly: "Your broker rejected the order request.", transient: false },
  10007: { key: "REQUEST_CANCELED", friendly: "The order was cancelled before it was placed.", transient: false },
  10008: { key: "ORDER_PLACED", friendly: "The order was placed.", transient: false },
  10009: { key: "DONE", friendly: "The trade was completed.", transient: false },
  10010: { key: "DONE_PARTIAL", friendly: "Only part of the order was filled.", transient: false },
  10011: { key: "ERROR", friendly: "The broker reported a processing error. The trade was not placed.", transient: true },
  10012: { key: "TIMEOUT", friendly: "The request timed out at the broker. The trade was not placed.", transient: true },
  10013: { key: "INVALID", friendly: "The order request was invalid.", transient: false },
  10014: { key: "INVALID_VOLUME", friendly: "The trade size is invalid for this symbol.", transient: false },
  10015: { key: "INVALID_PRICE", friendly: "The requested price is invalid.", transient: true },
  10016: { key: "INVALID_STOPS", friendly: "The stop loss or take profit is too close or invalid for this symbol.", transient: false },
  10017: { key: "TRADE_DISABLED", friendly: "Trading is disabled for this account or symbol.", transient: false },
  10018: { key: "MARKET_CLOSED", friendly: "The market for this symbol is closed.", transient: true },
  10019: { key: "NO_MONEY", friendly: "There is not enough free margin to place this trade.", transient: false },
  10020: { key: "PRICE_CHANGED", friendly: "The price changed before the order could be placed.", transient: true },
  10021: { key: "PRICE_OFF", friendly: "There are no quotes to process the request right now.", transient: true },
  10022: { key: "INVALID_EXPIRATION", friendly: "The order expiration is invalid.", transient: false },
  10023: { key: "ORDER_CHANGED", friendly: "The order state changed before processing.", transient: true },
  10024: { key: "TOO_MANY_REQUESTS", friendly: "Too many requests were sent too quickly. Slow down and retry.", transient: true },
  10025: { key: "NO_CHANGES", friendly: "The request made no changes.", transient: false },
  10026: { key: "SERVER_DISABLES_AT", friendly: "Automated trading is disabled by the broker server.", transient: false },
  10027: { key: "CLIENT_DISABLES_AT", friendly: "Algorithmic trading is disabled in your MT5 terminal. Enable AutoTrading.", transient: false },
  10028: { key: "LOCKED", friendly: "The order request is locked and being processed.", transient: true },
  10029: { key: "FROZEN", friendly: "The position or order is frozen and cannot be changed right now.", transient: true },
  10030: { key: "INVALID_FILL", friendly: "The order fill type is not supported for this symbol.", transient: false },
  10031: { key: "CONNECTION", friendly: "There is no connection to the trade server.", transient: true },
  10032: { key: "ONLY_REAL", friendly: "This operation is allowed only for live accounts.", transient: false },
  10033: { key: "LIMIT_ORDERS", friendly: "You have reached the broker's limit on pending orders.", transient: false },
  10034: { key: "LIMIT_VOLUME", friendly: "You have reached the broker's volume limit for this symbol.", transient: false },
  10035: { key: "INVALID_ORDER", friendly: "The order type is invalid or prohibited.", transient: false },
  10036: { key: "POSITION_CLOSED", friendly: "That position is already closed.", transient: false },
  10038: { key: "CLOSE_ORDER_EXIST", friendly: "A close order for this position already exists.", transient: false },
  10039: { key: "LIMIT_POSITIONS", friendly: "You have reached the broker's limit on open positions.", transient: false },
  10040: { key: "REJECT_CANCEL", friendly: "The broker rejected cancelling the order.", transient: false },
  10041: { key: "LONG_ONLY", friendly: "Only long (buy) positions are allowed on this symbol.", transient: false },
  10042: { key: "SHORT_ONLY", friendly: "Only short (sell) positions are allowed on this symbol.", transient: false },
  10043: { key: "CLOSE_ONLY", friendly: "This symbol is close-only — new positions are not allowed.", transient: false },
  10044: { key: "FIFO_CLOSE", friendly: "Positions must be closed in FIFO order on this account.", transient: false },
};

const UNKNOWN_OK: Mt5RetcodeEntry = { key: "UNKNOWN_OK", friendly: "The trade completed.", transient: false };
const UNKNOWN_FAIL: Mt5RetcodeEntry = { key: "UNKNOWN", friendly: "The broker rejected the trade for an unspecified reason.", transient: false };

/**
 * Resolve a raw MT5 retcode to its stable entry. Codes 10008–10010 are
 * successes; everything else (and unknown codes) is treated as a failure.
 */
export function explainMt5Retcode(code: number | null | undefined): Mt5RetcodeEntry {
  if (code == null) return UNKNOWN_FAIL;
  const entry = RETCODES[code];
  if (entry) return entry;
  if (code >= 10008 && code <= 10010) return UNKNOWN_OK;
  return UNKNOWN_FAIL;
}

/** A success retcode means the order was accepted/placed/done. */
export function isSuccessRetcode(code: number | null | undefined): boolean {
  return code != null && code >= 10008 && code <= 10010;
}

export interface Mt5RetcodeDictionaryEntry extends Mt5RetcodeEntry {
  code: number;
  success: boolean;
}

/**
 * The full known-retcode dictionary, sorted by numeric code. Used by the admin
 * Bridge Diagnostics surface to render the friendly explanation for every code
 * the EA can report. Pure data — no IO, no secrets.
 */
export function listMt5Retcodes(): Mt5RetcodeDictionaryEntry[] {
  return Object.entries(RETCODES)
    .map(([code, entry]) => ({
      code: Number(code),
      ...entry,
      success: isSuccessRetcode(Number(code)),
    }))
    .sort((a, b) => a.code - b.code);
}

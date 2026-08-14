// Phase 1 — Live-Position Truth resolver. The SINGLE backend source of truth for
// "what kind of position-shaped row is this, and may we treat it as a real,
// verified live position?".
//
// PURE / no-I/O. Callers normalise a row (live_positions, shared_trade_attribution,
// a scanner signal, or a pending order) into `PositionTruthInput`; this module
// returns the trust verdict. Ruby/Eleanor and every total/exposure/risk read
// build their honesty on this one classifier so a scanner signal or an unsynced,
// locally-created row can never be mistaken for a broker-confirmed live position.
//
// SAFETY — this resolver is BLOCK-ONLY. It can only downgrade a row and withhold
// advice. It NEVER grants trade permission, never places/modifies/closes
// anything, and is NOT part of the live execution gate chain. `adviceAllowed`
// governs only whether Ruby may discuss direction / hold / close on the row; it
// can never unlock or weaken the 18-gate live dispatch.

/** Per-row freshness verdict. Mirrors the server's `positionFreshness.Freshness`
 * (kept as a local literal so the domain package stays I/O- and import-free). */
export type PositionFreshness = "FRESH" | "STALE" | "MISSING";

/** The six mutually-exclusive trust categories any position-shaped row maps to. */
export type PositionTruthCategory =
  | "verified_live_position"
  | "attributed_but_incomplete_position"
  | "scanner_signal"
  | "pending_order"
  | "historical_closed"
  | "unsynced_unknown";

/** Stable badge token (Phase 2 renders these; Phase 1 only emits them). */
export type PositionTruthBadge =
  | "VERIFIED_LIVE"
  | "SYNC_INCOMPLETE"
  | "STALE"
  | "SCANNER_SIGNAL_ONLY"
  | "CLOSED_HISTORICAL"
  | "PENDING_ORDER"
  | "UNSYNCED";

/** Every field a row must carry to be a `verified_live_position`. */
export type VerifiedPositionField =
  | "brokerTicket"
  | "symbol"
  | "side"
  | "volume"
  | "entryPrice"
  | "currentPrice"
  | "unrealizedPnl"
  | "bridgeAccountSource"
  | "timestamp"
  | "freshness"
  | "attributionConfirmed";

/** The kind of source row being classified. Distinguishes a real position row
 * from a scanner signal or a not-yet-filled pending order so neither can ever be
 * promoted into a live position. */
export type PositionRowKind =
  | "live_position"
  | "shared_attribution"
  | "scanner_signal"
  | "pending_order";

export interface PositionTruthInput {
  rowKind: PositionRowKind;
  /** Broker/MT5 position ticket. Presence (non-null, non-empty) === broker-confirmed. */
  brokerTicket: string | number | null;
  symbol: string | null;
  /** Expected "BUY" | "SELL"; anything else is treated as missing. */
  side: string | null;
  /** Lot size / volume. */
  volume: number | null;
  entryPrice: number | null;
  currentPrice: number | null;
  unrealizedPnl: number | null;
  /** Bridge id / account source the row came from. */
  bridgeAccountSource: string | null;
  /** Opened-at ms epoch, if known. */
  openedAtMs: number | null;
  /** Last broker sync/update ms epoch, if known. */
  lastUpdateAtMs: number | null;
  /** Per-row freshness from `positionFreshness.classifyRow`. */
  freshness: PositionFreshness;
  /** True only when the row is confirmed attributed to THIS user/master allocation. */
  attributionConfirmed: boolean;
  /** True when a broker-confirmed CLOSE stamped the row OR its status is terminal. */
  closed: boolean;
}

export interface PositionTruthVerdict {
  category: PositionTruthCategory;
  badge: PositionTruthBadge;
  /** True ONLY for category === "verified_live_position". */
  isVerifiedLive: boolean;
  /** True when the row carries a real broker ticket (a real position exists). */
  brokerConfirmed: boolean;
  /** True when the row is real broker exposure right now (broker-confirmed AND open).
   *  A broker-ticketed but data-lagging row STILL counts toward exposure/risk;
   *  only a not-broker-confirmed (no ticket) row is excluded from totals. */
  countsTowardExposure: boolean;
  /** True ONLY when Ruby may give a side / hold / close / manage opinion on this
   *  row. Equivalent to isVerifiedLive. Block-only — never grants execution. */
  adviceAllowed: boolean;
  /** Fields missing/unconfirmed that prevent the row being verified. */
  missingFields: VerifiedPositionField[];
  /** Human reason Ruby can quote verbatim for why advice is allowed/withheld. */
  reason: string;
}

const REFUSAL_NOT_BROKER_CONFIRMED =
  "Not broker-confirmed — this row was created locally and has no broker ticket yet, so I can't treat it as a verified live position or give a side or hold/close advice on it.";

function hasTicket(t: string | number | null): boolean {
  if (t == null) return false;
  if (typeof t === "number") return Number.isFinite(t) && t > 0;
  return t.trim() !== "" && t.trim() !== "0";
}

function isValidSide(s: string | null): boolean {
  const u = (s ?? "").trim().toUpperCase();
  return u === "BUY" || u === "SELL";
}

/** Compute the set of fields that block a position row from being verified. */
function computeMissingFields(input: PositionTruthInput): VerifiedPositionField[] {
  const missing: VerifiedPositionField[] = [];
  if (!hasTicket(input.brokerTicket)) missing.push("brokerTicket");
  if (!input.symbol || input.symbol.trim() === "") missing.push("symbol");
  if (!isValidSide(input.side)) missing.push("side");
  if (input.volume == null || !Number.isFinite(input.volume) || input.volume <= 0) {
    missing.push("volume");
  }
  if (input.entryPrice == null || !Number.isFinite(input.entryPrice)) missing.push("entryPrice");
  if (input.currentPrice == null || !Number.isFinite(input.currentPrice)) missing.push("currentPrice");
  // P/L is computable when entry + current + side + volume are all present, so it
  // is only "missing" when we have neither a reported P/L nor a current price to
  // derive it from.
  if (
    (input.unrealizedPnl == null || !Number.isFinite(input.unrealizedPnl)) &&
    (input.currentPrice == null || !Number.isFinite(input.currentPrice))
  ) {
    missing.push("unrealizedPnl");
  }
  if (!input.bridgeAccountSource || input.bridgeAccountSource.trim() === "") {
    missing.push("bridgeAccountSource");
  }
  if (input.openedAtMs == null && input.lastUpdateAtMs == null) missing.push("timestamp");
  if (input.freshness !== "FRESH") missing.push("freshness");
  if (!input.attributionConfirmed) missing.push("attributionConfirmed");
  return missing;
}

/**
 * Classify a single position-shaped row into its trust category + advice verdict.
 * Pure. Block-only. Never grants execution permission.
 */
export function resolvePositionTruth(input: PositionTruthInput): PositionTruthVerdict {
  // 1. A scanner signal is never a position — it can never be promoted.
  if (input.rowKind === "scanner_signal") {
    return {
      category: "scanner_signal",
      badge: "SCANNER_SIGNAL_ONLY",
      isVerifiedLive: false,
      brokerConfirmed: false,
      countsTowardExposure: false,
      adviceAllowed: false,
      missingFields: [],
      reason:
        "This is a scanner signal, not an open position. It reflects a potential setup, not a trade you currently hold — I won't describe it as a live buy/sell you're in.",
    };
  }

  // 2. A pending order is not filled at the broker → not a live position.
  if (input.rowKind === "pending_order") {
    return {
      category: "pending_order",
      badge: "PENDING_ORDER",
      isVerifiedLive: false,
      brokerConfirmed: hasTicket(input.brokerTicket),
      countsTowardExposure: false,
      adviceAllowed: false,
      missingFields: [],
      reason:
        "This is a pending order that has not filled at the broker yet, so it isn't an open live position. I can't give hold/close advice on a position you don't hold yet.",
    };
  }

  // 3. A closed/terminal row is history, never a current position.
  if (input.closed) {
    return {
      category: "historical_closed",
      badge: "CLOSED_HISTORICAL",
      isVerifiedLive: false,
      brokerConfirmed: hasTicket(input.brokerTicket),
      countsTowardExposure: false,
      adviceAllowed: false,
      missingFields: [],
      reason:
        "This position is closed/historical — it's no longer open, so there's nothing to hold or close.",
    };
  }

  // 4. An open position row (live_position / shared_attribution).
  const brokerConfirmed = hasTicket(input.brokerTicket);
  const missingFields = computeMissingFields(input);

  // 4a. No broker ticket → not broker-confirmed → unsynced/unknown. Excluded from
  // all totals; advice always withheld; shown only as a diagnostic/repair row.
  if (!brokerConfirmed) {
    return {
      category: "unsynced_unknown",
      badge: "UNSYNCED",
      isVerifiedLive: false,
      brokerConfirmed: false,
      countsTowardExposure: false,
      adviceAllowed: false,
      missingFields,
      reason: REFUSAL_NOT_BROKER_CONFIRMED,
    };
  }

  // 4b. Broker ticket present but the verified field set is incomplete (lagging
  // price/P&L, stale snapshot, or attribution not yet confirmed). This IS real
  // broker exposure (it counts toward totals/risk), but advice stays withheld.
  if (missingFields.length > 0) {
    const stale = input.freshness !== "FRESH";
    return {
      category: "attributed_but_incomplete_position",
      badge: stale ? "STALE" : "SYNC_INCOMPLETE",
      isVerifiedLive: false,
      brokerConfirmed: true,
      countsTowardExposure: true,
      adviceAllowed: false,
      missingFields,
      reason:
        `This is a real broker position, but I can't fully verify it yet (missing/unconfirmed: ${missingFields.join(", ")}). ` +
        "I won't give hold or close advice until the broker sync confirms entry, current price, P/L, and freshness.",
    };
  }

  // 4c. Fully verified live position — all fields present, fresh, attributed.
  return {
    category: "verified_live_position",
    badge: "VERIFIED_LIVE",
    isVerifiedLive: true,
    brokerConfirmed: true,
    countsTowardExposure: true,
    adviceAllowed: true,
    missingFields: [],
    reason:
      "Verified live position — broker ticket, symbol, side, volume, entry, current price, P/L, account source, and a fresh timestamp are all confirmed and attributed to you.",
  };
}

/** Convenience: true when Ruby may discuss direction/hold/close on this verdict. */
export function mayAdviseOnPosition(verdict: PositionTruthVerdict): boolean {
  return verdict.adviceAllowed === true && verdict.isVerifiedLive === true;
}

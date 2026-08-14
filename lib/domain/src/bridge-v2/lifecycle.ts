// ── ARX Bridge v2 — unified lifecycle truth model (Task #371, Phase 5) ───────
//
// One canonical vocabulary spanning the WHOLE order/position lifecycle, so no
// surface ever conflates "dispatched" with "filled" or "partial close" with
// "fully closed". PURE: no IO. The server maps the existing arx_live_commands
// statuses and OnTradeTransaction events ONTO these states; UI/AI read these.
//
// Inviolable truth rules encoded here:
//   - DISPATCH ≠ FILL. SENT_TO_BRIDGE / BROKER_RECEIVED are NOT filled states.
//   - A state may only become FILLED on confirmed broker evidence (deal/ticket).
//   - PARTIALLY_CLOSED ≠ CLOSED. A position is CLOSED only when broker truth
//     shows zero remaining volume.
//   - Terminal states never transition back to an active state.

export const BRIDGE_V2_LIFECYCLE_STATES = [
  // ── pre-broker (no money at risk; purely ARX-side) ──
  "REQUESTED", // user/Ruby/agent asked for an action
  "QUEUED", // drafted + accepted into the dispatch queue (ARX side)
  "SENT_TO_BRIDGE", // claimed by the EA poll / mirrored into transport
  // ── broker handshake ──
  "BROKER_RECEIVED", // EA reports the broker accepted the request (NOT a fill)
  "BROKER_ACCEPTED", // broker validated the order (still NOT necessarily filled)
  // ── fill truth ──
  "PARTIALLY_FILLED", // some volume filled, remainder working
  "FILLED", // fully filled — confirmed by deal ticket + retcode
  "OPEN", // a filled position currently open in the broker book
  // ── close truth ──
  "CLOSE_REQUESTED",
  "CLOSE_SENT_TO_BRIDGE",
  "PARTIALLY_CLOSED", // some volume closed, remainder still OPEN
  "CLOSED", // zero remaining volume — confirmed by broker
  // ── terminal non-fill outcomes ──
  "REJECTED", // broker rejected (carry the real retcode/reason)
  "FAILED", // transport/EA failure before a broker decision
  "CANCELLED", // cancelled before reaching the broker
  "EXPIRED", // TTL elapsed with no broker outcome
  "BLOCKED", // a safety gate refused dispatch (LIVE_BLOCKED:<gate>)
] as const;

export type BridgeV2LifecycleState = (typeof BRIDGE_V2_LIFECYCLE_STATES)[number];

const FILLED_STATES: ReadonlySet<BridgeV2LifecycleState> = new Set([
  "PARTIALLY_FILLED",
  "FILLED",
  "OPEN",
  "CLOSE_REQUESTED",
  "CLOSE_SENT_TO_BRIDGE",
  "PARTIALLY_CLOSED",
]);

const TERMINAL_STATES: ReadonlySet<BridgeV2LifecycleState> = new Set([
  "CLOSED",
  "REJECTED",
  "FAILED",
  "CANCELLED",
  "EXPIRED",
  "BLOCKED",
]);

// A state that means "this order has resulted in real broker volume". UI may
// only show an open-position card when the state is one of these.
export function isFilledState(s: BridgeV2LifecycleState): boolean {
  return FILLED_STATES.has(s);
}

export function isTerminalState(s: BridgeV2LifecycleState): boolean {
  return TERMINAL_STATES.has(s);
}

// "Dispatched but not yet broker-confirmed as filled" — the exact band where a
// UI bug would wrongly render a queued order as an open/filled position.
export function isDispatchedNotFilled(s: BridgeV2LifecycleState): boolean {
  return s === "QUEUED" || s === "SENT_TO_BRIDGE" || s === "BROKER_RECEIVED" || s === "BROKER_ACCEPTED";
}

// Allowed forward transitions. Anything not listed is rejected by the mapper so
// a stale/duplicate/out-of-order event can never downgrade or fabricate state.
const TRANSITIONS: Record<BridgeV2LifecycleState, readonly BridgeV2LifecycleState[]> = {
  REQUESTED: ["QUEUED", "BLOCKED", "CANCELLED", "FAILED"],
  QUEUED: ["SENT_TO_BRIDGE", "BLOCKED", "CANCELLED", "EXPIRED", "FAILED"],
  SENT_TO_BRIDGE: ["BROKER_RECEIVED", "REJECTED", "FAILED", "EXPIRED"],
  BROKER_RECEIVED: ["BROKER_ACCEPTED", "PARTIALLY_FILLED", "FILLED", "REJECTED", "FAILED"],
  BROKER_ACCEPTED: ["PARTIALLY_FILLED", "FILLED", "REJECTED", "FAILED"],
  PARTIALLY_FILLED: ["FILLED", "OPEN", "CLOSED", "FAILED"],
  FILLED: ["OPEN", "CLOSE_REQUESTED", "CLOSED"],
  OPEN: ["CLOSE_REQUESTED", "PARTIALLY_CLOSED", "CLOSED"],
  CLOSE_REQUESTED: ["CLOSE_SENT_TO_BRIDGE", "OPEN", "FAILED"],
  CLOSE_SENT_TO_BRIDGE: ["PARTIALLY_CLOSED", "CLOSED", "OPEN", "FAILED"],
  PARTIALLY_CLOSED: ["CLOSED", "OPEN"],
  CLOSED: [],
  REJECTED: [],
  FAILED: [],
  CANCELLED: [],
  EXPIRED: [],
  BLOCKED: [],
};

export function canTransition(
  from: BridgeV2LifecycleState,
  to: BridgeV2LifecycleState,
): boolean {
  if (from === to) return true; // idempotent re-assert is allowed (no-op)
  return TRANSITIONS[from]?.includes(to) ?? false;
}

// Map a legacy arx_live_commands status onto the unified lifecycle vocabulary.
// Keeps existing persistence untouched while giving UI/AI one truth model.
export function mapLegacyLiveCommandStatus(status: string): BridgeV2LifecycleState | null {
  switch (status) {
    case "LIVE_DRAFT":
    case "LIVE_CONFIRMATION_REQUIRED":
      return "REQUESTED";
    case "LIVE_APPROVED":
      return "QUEUED";
    case "SENT_TO_MT5_LIVE":
      return "SENT_TO_BRIDGE";
    case "LIVE_FILLED":
      return "FILLED";
    case "LIVE_CLOSED":
      return "CLOSED";
    case "LIVE_REJECTED":
      return "REJECTED";
    case "LIVE_FAILED":
      return "FAILED";
    case "LIVE_CANCELLED":
      return "CANCELLED";
    case "LIVE_EXPIRED":
      return "EXPIRED";
    case "LIVE_BLOCKED":
      return "BLOCKED";
    default:
      return null;
  }
}

// Derive the lifecycle state implied by a COMMAND_RESULT outcome. Never returns
// a filled state without broker evidence (ticket present).
export function lifecycleFromCommandResult(
  outcome: "EXECUTED" | "PARTIAL" | "REJECTED" | "FAILED",
  hasBrokerTicket: boolean,
): BridgeV2LifecycleState {
  switch (outcome) {
    case "EXECUTED":
      return hasBrokerTicket ? "FILLED" : "FAILED";
    case "PARTIAL":
      return hasBrokerTicket ? "PARTIALLY_FILLED" : "FAILED";
    case "REJECTED":
      return "REJECTED";
    case "FAILED":
      return "FAILED";
  }
}

// Best-effort lifecycle classification for an ingested message. This switch is
// EXHAUSTIVE over every v2 message type so adding a new type is a deliberate
// decision, not a silent fall-through to `default`. Only COMMAND_RESULT /
// TRADE_TRANSACTION / DEAL_HISTORY can imply a lifecycle state, and only on
// confirmed broker evidence — never a fabricated fill. Every other type is pure
// TELEMETRY (no order/position lifecycle) and returns null on purpose: honesty
// over coverage count. PURE: payload is read defensively, never trusted typed.
export function mapLifecycleForMessage(
  messageType: string,
  payload: unknown,
): BridgeV2LifecycleState | null {
  const p = (payload ?? {}) as Record<string, unknown>;
  switch (messageType) {
    // ── Lifecycle-bearing types (broker evidence required) ──────────────────
    case "COMMAND_RESULT": {
      const outcome = String(p.outcome ?? "");
      const hasTicket = typeof p.brokerTicket === "string" && p.brokerTicket.length > 0;
      if (outcome === "EXECUTED" || outcome === "PARTIAL" || outcome === "REJECTED" || outcome === "FAILED") {
        return lifecycleFromCommandResult(outcome, hasTicket);
      }
      return null;
    }
    case "TRADE_TRANSACTION": {
      // A deal ticket on a DEAL_ADD transaction is a confirmed fill. Without a
      // deal ticket we only know the broker received/accepted — NOT a fill.
      const txType = String(p.transactionType ?? "");
      const hasDeal = typeof p.dealTicket === "string" && p.dealTicket.length > 0;
      if (txType.includes("DEAL_ADD") && hasDeal) return "FILLED";
      if (txType.includes("REQUEST")) return "BROKER_RECEIVED";
      if (txType.includes("ORDER_ADD")) return "BROKER_ACCEPTED";
      return null;
    }
    case "DEAL_HISTORY":
      // A historical deal is realised truth; it reflects a closed leg.
      return "CLOSED";

    // ── Pure telemetry types — NO order/position lifecycle (null on purpose) ──
    // HEARTBEAT: bridge liveness only — no order state.
    case "HEARTBEAT":
    // ACCOUNT_SNAPSHOT: balance/equity/margin truth — not a per-order state.
    case "ACCOUNT_SNAPSHOT":
    // POSITIONS_SNAPSHOT / ORDERS_SNAPSHOT: a roll-up of CURRENT broker state.
    // We deliberately do NOT derive a per-command lifecycle from a snapshot here
    // — fill/close truth comes from COMMAND_RESULT / TRADE_TRANSACTION, never
    // from inferring it across a snapshot diff.
    case "POSITIONS_SNAPSHOT":
    case "ORDERS_SNAPSHOT":
    // TICK / CANDLE: market data only.
    case "TICK":
    case "CANDLE":
    // SYMBOL_SPEC: instrument metadata.
    case "SYMBOL_SPEC":
    // ERROR_REPORT: operator-actionable diagnostics — never a trade state.
    case "ERROR_REPORT":
    // CONFIG_ACK: the EA acknowledging an applied config version — config-loop
    // telemetry, not an order/position lifecycle.
    case "CONFIG_ACK":
      return null;

    default:
      // An unknown/unlisted type carries no lifecycle. Validation upstream
      // already rejects types without a payload schema; this is a safety net.
      return null;
  }
}

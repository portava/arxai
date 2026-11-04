// Live pending-order controls — cancel / modify a working MT5 pending order
// (Buy/Sell Limit, Stop, Stop Limit) that ARX placed through the live pipeline.
//
// Pure: no DB, no network. The live pipeline (createLiveOpsDraft →
// confirmLiveCommand → dispatchLiveCommand → recordLiveCommandResult) calls
// these so every rule is unit-tested in one place.
//
// Two live command types (text column, no migration):
//   CANCEL_LIVE_PENDING_ORDER → EA action CANCEL_PENDING (v154 HandleCancelPending)
//   MODIFY_LIVE_PENDING_ORDER → EA action MODIFY_PENDING (v154 HandleModifyPending)
//
// The v154 Universal Agent reads `orderTicket` for both. MODIFY_PENDING also
// reads `entry` (0 / absent = keep the order's price), `sl` and `tp` (the
// mt5_commands columns) — and passes sl/tp straight to OrderModify, where 0
// REMOVES the level. So a modify always carries the effective SL and TP (the
// requested value, else the current one); it never sends 0 for "unchanged".
// Expiry and the stop-limit leg are kept by the EA when not given.
//
// Risk posture:
//   • cancel is risk-reducing (the order can no longer fill): it passes every
//     entry-only gate, like CLOSE_LIVE_POSITION, and the Risk Governor sees it
//     as a CLOSE. It does NOT get the admin emergency-close kill-switch bypass
//     (that stays CLOSE-only, admin-only); a user cancel follows the same
//     per-user kill-switch rule as a user close.
//   • modify is NOT risk-reducing (it moves where new exposure opens): it is
//     refused by the "open nothing new" postures (safety-core kill switch,
//     trading freeze, close-only, risk locks) and the Risk Governor sees it
//     as a MODIFY whose stop is measured by its distance from the new entry.

import { classifyOrderType, validatePendingOrder, validateProtection, type OrderSide } from "./pendingOrderRules.js";

export const CANCEL_LIVE_PENDING_ORDER = "CANCEL_LIVE_PENDING_ORDER" as const;
export const MODIFY_LIVE_PENDING_ORDER = "MODIFY_LIVE_PENDING_ORDER" as const;
export type PendingControlCommandType = typeof CANCEL_LIVE_PENDING_ORDER | typeof MODIFY_LIVE_PENDING_ORDER;
export const PENDING_CONTROL_COMMAND_TYPES: readonly PendingControlCommandType[] = [
  CANCEL_LIVE_PENDING_ORDER, MODIFY_LIVE_PENDING_ORDER,
];

export function isPendingControlCommandType(t: string | null | undefined): t is PendingControlCommandType {
  return t === CANCEL_LIVE_PENDING_ORDER || t === MODIFY_LIVE_PENDING_ORDER;
}

/** EA mailbox action for each control (v154 dispatcher names). */
export const PENDING_CONTROL_EA_ACTION: Record<PendingControlCommandType, string> = {
  CANCEL_LIVE_PENDING_ORDER: "CANCEL_PENDING",
  MODIFY_LIVE_PENDING_ORDER: "MODIFY_PENDING",
};

/** Command-row order_type for the control row (the order's own type lives on the original). */
export const PENDING_CONTROL_ORDER_TYPE: Record<PendingControlCommandType, string> = {
  CANCEL_LIVE_PENDING_ORDER: "CANCEL_PENDING",
  MODIFY_LIVE_PENDING_ORDER: "MODIFY_PENDING",
};

/** Sensitive-action class (command integrity `action_type`). */
export function pendingControlActionType(t: PendingControlCommandType): string {
  return t === CANCEL_LIVE_PENDING_ORDER ? "CANCEL_PENDING_ORDER" : "MODIFY_PENDING_ORDER";
}

/**
 * True for a control the "open nothing new" postures refuse (safety-core kill
 * switch, trading freeze, close-only, risk locks). Cancel only reduces risk.
 */
export function pendingControlRestrictedByEntryPosture(t: string): boolean {
  return t === MODIFY_LIVE_PENDING_ORDER;
}

// ── Ownership / controllability ────────────────────────────────────────────

/** The only status a control may target: placed at the broker, not filled. */
export const CONTROLLABLE_PENDING_STATUS = "LIVE_ACKNOWLEDGED" as const;

/** Control rows still in flight (a second control on the same order is refused). */
export const PENDING_CONTROL_IN_FLIGHT_STATUSES = [
  "LIVE_DRAFT", "LIVE_CONFIRMATION_REQUIRED", "LIVE_APPROVED", "SENT_TO_MT5_LIVE",
  "LIVE_UNKNOWN", "LIVE_RECONCILIATION_REQUIRED",
] as const;

export type PendingOrderRowFacts = {
  commandId: string;
  userId: number;
  commandType: string;
  status: string;
  brokerTicket: string | null;
  symbol: string;
  side: string;
  orderType: string;
  requestedVolume: number;
  stopLoss: number | null;
  takeProfit: number | null;
  payload: unknown;
};

export type ControllableCheck =
  | { ok: true; orderTicket: string }
  | { ok: false; reason:
      | "PENDING_ORDER_NOT_FOUND"
      | "PENDING_ORDER_NOT_OWNED"
      | "NOT_A_PENDING_ORDER"
      | "PENDING_ORDER_NOT_WORKING"
      | "PENDING_ORDER_TICKET_MISSING"
      | "PENDING_ORDER_FILLED"
      | "PENDING_ORDER_EXPIRED"
      | "PENDING_ORDER_CONTROL_IN_FLIGHT";
      detail: string };

const positive = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);

export function normalizeOrderTicket(t: unknown): string | null {
  const s = t == null ? "" : String(t).trim();
  return /^[1-9]\d{0,19}$/.test(s) ? s : null;
}

/**
 * PURE — may `userId` cancel / modify this ledger row? Only their own
 * PLACE_LIVE_PENDING_ORDER that the EA answered with an order ticket
 * (LIVE_ACKNOWLEDGED), that has not filled into a position, has not expired,
 * and has no other control in flight.
 */
export function checkPendingOrderControllable(args: {
  row: PendingOrderRowFacts | null | undefined;
  userId: number;
  positionTickets: ReadonlySet<string>;
  inFlightControlCount: number;
  nowMs?: number;
}): ControllableCheck {
  const r = args.row;
  if (!r) return { ok: false, reason: "PENDING_ORDER_NOT_FOUND", detail: "No such live pending order." };
  if (r.userId !== args.userId) return { ok: false, reason: "PENDING_ORDER_NOT_OWNED", detail: "That pending order is not yours." };
  if (r.commandType !== "PLACE_LIVE_PENDING_ORDER") return { ok: false, reason: "NOT_A_PENDING_ORDER", detail: "That command is not a live pending order." };
  const ticket = normalizeOrderTicket(r.brokerTicket);
  if (!ticket) return { ok: false, reason: "PENDING_ORDER_TICKET_MISSING", detail: "The broker never confirmed an order ticket for this order." };
  if (r.status !== CONTROLLABLE_PENDING_STATUS) {
    return { ok: false, reason: "PENDING_ORDER_NOT_WORKING", detail: `This order is ${r.status}; only a working order placed at the broker can be cancelled or changed from ARX.` };
  }
  if (args.positionTickets.has(ticket)) return { ok: false, reason: "PENDING_ORDER_FILLED", detail: "This order has already filled into a position. Manage the position instead." };
  const p = (r.payload ?? {}) as Record<string, unknown>;
  const exp = positive(p["expirationEpoch"]);
  if (exp != null && exp * 1000 <= (args.nowMs ?? Date.now())) {
    return { ok: false, reason: "PENDING_ORDER_EXPIRED", detail: "This order's expiry time has passed at the broker." };
  }
  if (args.inFlightControlCount > 0) {
    return { ok: false, reason: "PENDING_ORDER_CONTROL_IN_FLIGHT", detail: "A cancel or change for this order is already on its way to MT5. Wait for its answer." };
  }
  return { ok: true, orderTicket: ticket };
}

// ── Current levels (original + latest confirmed modify) ────────────────────

export type PendingLevels = { price: number | null; stopLimitPrice: number | null; stopLoss: number | null; takeProfit: number | null };

/** The original placement's levels (draft payload price / entry; SL/TP columns). */
export function originalPendingLevels(row: Pick<PendingOrderRowFacts, "payload" | "stopLoss" | "takeProfit">): PendingLevels {
  const p = (row.payload ?? {}) as Record<string, unknown>;
  return {
    price: positive(p["price"]) ?? positive(p["entry"]),
    stopLimitPrice: positive(p["stopLimitPrice"]),
    stopLoss: positive(row.stopLoss),
    takeProfit: positive(row.takeProfit),
  };
}

/**
 * The tracked state of a modified order. The original row's draft fields are
 * integrity-hashed and stay as placed; a broker-confirmed modify (its own
 * MODIFY_LIVE_PENDING_ORDER row, LIVE_FILLED) is the record of the change, so
 * the current levels are the original's overlaid by the latest such row.
 */
export function currentPendingLevels(
  original: Pick<PendingOrderRowFacts, "payload" | "stopLoss" | "takeProfit">,
  latestConfirmedModify: { payload: unknown } | null | undefined,
): PendingLevels {
  const base = originalPendingLevels(original);
  const m = latestConfirmedModify ? ((latestConfirmedModify.payload ?? {}) as Record<string, unknown>)["pendingModifyV1"] : null;
  if (!m || typeof m !== "object") return base;
  const after = (m as Record<string, unknown>)["after"] as Record<string, unknown> | undefined;
  if (!after) return base;
  return {
    price: positive(after["price"]) ?? base.price,
    stopLimitPrice: base.stopLimitPrice,
    stopLoss: positive(after["stopLoss"]) ?? base.stopLoss,
    takeProfit: positive(after["takeProfit"]) ?? base.takeProfit,
  };
}

// ── Modify validation (MT5 rules, server side) ─────────────────────────────

export type PendingModifyCheck =
  | { ok: true; effective: { price: number; stopLoss: number | null; takeProfit: number | null }; priceChanged: boolean }
  | { ok: false; code: string; detail: string };

/**
 * PURE — validate a requested change. Empty fields keep the current level.
 * The new trigger price must sit on MT5's side of the bid/ask for the order
 * type (skipped when no fresh two-sided quote: the broker enforces it), and
 * SL/TP on the correct side of the reference (pending price, or the stop-limit
 * order's limit price). Removing a level is not supported (the live EA has no
 * "leave as is" for a pending SL/TP, so 0 would remove it silently).
 */
export function validatePendingModify(args: {
  orderType: string;
  side: OrderSide;
  current: PendingLevels;
  next: { price?: number | null; stopLoss?: number | null; takeProfit?: number | null };
  bid: number | null;
  ask: number | null;
}): PendingModifyCheck {
  const bad = (v: unknown) => v != null && !(typeof v === "number" && Number.isFinite(v) && v > 0);
  if (bad(args.next.price)) return { ok: false, code: "INVALID_PRICE", detail: "The order price must be a number above 0." };
  if (bad(args.next.stopLoss)) return { ok: false, code: "INVALID_STOP_LOSS", detail: "Stop Loss must be a price above 0. Removing it is done in MT5." };
  if (bad(args.next.takeProfit)) return { ok: false, code: "INVALID_TAKE_PROFIT", detail: "Take Profit must be a price above 0. Removing it is done in MT5." };
  const price = positive(args.next.price) ?? args.current.price;
  if (price == null) return { ok: false, code: "MISSING_PENDING_PRICE", detail: "The order's current price is unknown, so give the new price." };
  const stopLoss = positive(args.next.stopLoss) ?? args.current.stopLoss;
  const takeProfit = positive(args.next.takeProfit) ?? args.current.takeProfit;
  const same = (a: number | null, b: number | null) => a === b || (a != null && b != null && Math.abs(a - b) < 1e-12);
  const priceChanged = !same(price, args.current.price);
  if (!priceChanged && same(stopLoss, args.current.stopLoss) && same(takeProfit, args.current.takeProfit)) {
    return { ok: false, code: "NO_CHANGES", detail: "Change the price, Stop Loss or Take Profit first." };
  }
  const cls = classifyOrderType(args.orderType, args.side);
  if (!cls.pending) return { ok: false, code: "NOT_A_PENDING_ORDER", detail: "Only a pending order's price can be changed." };
  // The trigger price is only checked when it changes: an unchanged order may
  // have drifted next to the market and is still a valid order at the broker.
  if (priceChanged) {
    const p = validatePendingOrder({
      orderType: cls.canonical, action: args.side, price,
      stopLimitPrice: args.current.stopLimitPrice, bid: args.bid, ask: args.ask,
    });
    if (!p.ok) return { ok: false, code: p.code, detail: p.detail };
  }
  const reference = cls.kind === "STOP_LIMIT" ? (args.current.stopLimitPrice ?? price) : price;
  const prot = validateProtection({ side: args.side, reference, stopLoss, takeProfit });
  if (!prot.ok) return { ok: false, code: prot.code, detail: prot.detail };
  return { ok: true, effective: { price, stopLoss, takeProfit }, priceChanged };
}

// ── EA mailbox payload ─────────────────────────────────────────────────────

/**
 * The extra wire keys for the mt5_commands mirror row. Throws on a missing /
 * zero order ticket (a cancel sent with ticket 0 would be answered "not
 * found" — never send it). `entry` only when the price changes (absent = the
 * EA keeps the order's own price); no `expirationEpoch` (the EA keeps the
 * order's expiry). SL/TP ride in the mt5_commands sl/tp columns.
 */
export function pendingControlMirrorPayload(commandType: PendingControlCommandType, payload: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const p = payload ?? {};
  const ticket = normalizeOrderTicket(p["orderTicket"]);
  if (!ticket) throw new Error(`LIVE_BRIDGE_ORDER_TICKET_MISSING:${commandType}`);
  const out: Record<string, unknown> = { orderTicket: ticket, targetCommandId: p["targetCommandId"] ?? null };
  if (commandType === MODIFY_LIVE_PENDING_ORDER) {
    const m = (p["pendingModifyV1"] ?? {}) as Record<string, unknown>;
    const after = (m["after"] ?? {}) as Record<string, unknown>;
    if (m["priceChanged"] === true) {
      const entry = positive(after["price"]);
      if (entry != null) out.entry = entry;
    }
  }
  return out;
}

// ── EA result mapping ──────────────────────────────────────────────────────

/**
 * PURE — the outcome of a control command's EA answer. Called after the
 * shared stale / failure / not-executed checks. v154 answers CANCELLED or
 * MODIFIED with the order ticket on success.
 *   cancel → LIVE_CANCELLED (terminal, not a fill; the original order is then
 *            cancelled and its reservation released)
 *   modify → LIVE_FILLED (terminal "executed at the broker", the same terminal
 *            MODIFY_LIVE_SLTP uses; a modify never opens a position)
 * Any other success-looking answer, or no ticket → LIVE_UNKNOWN.
 */
export function mapPendingControlOutcome(input: {
  commandType: PendingControlCommandType;
  status: string;
  hasBrokerTicket: boolean;
}): "LIVE_CANCELLED" | "LIVE_FILLED" | "LIVE_UNKNOWN" {
  const s = (input.status ?? "").toLowerCase();
  if (!input.hasBrokerTicket) return "LIVE_UNKNOWN";
  if (input.commandType === CANCEL_LIVE_PENDING_ORDER) return s === "cancelled" || s === "canceled" ? "LIVE_CANCELLED" : "LIVE_UNKNOWN";
  return s === "modified" ? "LIVE_FILLED" : "LIVE_UNKNOWN";
}

/**
 * Result-path-only transition for a control: SENT → LIVE_CANCELLED is legal
 * for a CANCEL_LIVE_PENDING_ORDER (the broker removed the order). It is not
 * added to the shared table, so no user/operator cancel path can move a SENT
 * command to cancelled and release a held reservation.
 */
export function isAllowedPendingControlResultTransition(commandType: string, from: string, to: string): boolean {
  return commandType === CANCEL_LIVE_PENDING_ORDER && from === "SENT_TO_MT5_LIVE" && to === "LIVE_CANCELLED";
}

/** The original pending row's transition once the broker confirms the cancel. */
export function originalStatusAfterControl(commandType: string, controlFinalStatus: string, originalStatus: string): "LIVE_CANCELLED" | null {
  if (commandType !== CANCEL_LIVE_PENDING_ORDER || controlFinalStatus !== "LIVE_CANCELLED") return null;
  return originalStatus === CONTROLLABLE_PENDING_STATUS ? "LIVE_CANCELLED" : null;
}

// ── Risk Governor intent ───────────────────────────────────────────────────

/**
 * PURE — the Risk Governor view of a control.
 *   cancel → CLOSE of the order's lots (reduce-only rules only).
 *   modify → MODIFY at the new entry. The "position" is the order with its
 *            stop translated to keep the OLD risk distance from the NEW entry,
 *            so the governor's widen check compares risk distance: moving the
 *            entry away from the stop (or the stop away from the entry) is a
 *            widen, judged against the per-trade loss limit.
 */
export function pendingControlRiskIntent(args: {
  commandType: PendingControlCommandType;
  side: OrderSide;
  before: PendingLevels;
  after: { price: number | null; stopLoss: number | null; takeProfit: number | null };
}): { action: "CLOSE" | "MODIFY"; entryPrice: number | null; stopLoss: number | null; takeProfit: number | null;
  position: { entryPrice: number; stopLoss: number | null } | null } {
  if (args.commandType === CANCEL_LIVE_PENDING_ORDER) {
    return { action: "CLOSE", entryPrice: null, stopLoss: null, takeProfit: null, position: null };
  }
  const entry = args.after.price ?? args.before.price;
  if (entry == null) return { action: "MODIFY", entryPrice: null, stopLoss: args.after.stopLoss, takeProfit: args.after.takeProfit, position: null };
  const oldEntry = args.before.price ?? entry;
  const oldSl = args.before.stopLoss;
  const equivalentStop = oldSl == null ? null : entry - (oldEntry - oldSl);
  return {
    action: "MODIFY",
    entryPrice: entry,
    stopLoss: args.after.stopLoss,
    takeProfit: args.after.takeProfit,
    position: { entryPrice: entry, stopLoss: equivalentStop != null && equivalentStop > 0 ? equivalentStop : oldSl },
  };
}

// ── Route helpers (pure) ───────────────────────────────────────────────────

/**
 * One-click / confirmation rule for the pending-order routes. With live
 * one-click ON the button press is the confirmation (like a one-click close);
 * with it OFF the client must have shown its confirm dialog and say so with
 * `confirmedByUser: true` (the modify dialog's explicit submit counts).
 */
export function pendingControlNeedsConfirmation(args: { oneClickOn: boolean; confirmedByUser: unknown }): boolean {
  return !args.oneClickOn && args.confirmedByUser !== true;
}

const optNum = (v: unknown): number | null | "BAD" => {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : "BAD";
};

/** `{price?, sl?, tp?}` (aliases stopLoss / takeProfit). Empty = keep the current level. */
export function parsePendingModifyBody(body: unknown):
  | { ok: true; price: number | null; stopLoss: number | null; takeProfit: number | null }
  | { ok: false; code: "INVALID_PRICE" | "INVALID_STOP_LOSS" | "INVALID_TAKE_PROFIT" | "NO_CHANGES"; detail: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const price = optNum(b["price"]);
  const sl = optNum(b["sl"] ?? b["stopLoss"]);
  const tp = optNum(b["tp"] ?? b["takeProfit"]);
  if (price === "BAD") return { ok: false, code: "INVALID_PRICE", detail: "The order price must be a number above 0." };
  if (sl === "BAD") return { ok: false, code: "INVALID_STOP_LOSS", detail: "Stop Loss must be a price above 0. Removing it is done in MT5." };
  if (tp === "BAD") return { ok: false, code: "INVALID_TAKE_PROFIT", detail: "Take Profit must be a price above 0. Removing it is done in MT5." };
  if (price == null && sl == null && tp == null) return { ok: false, code: "NO_CHANGES", detail: "Give a new price, Stop Loss or Take Profit." };
  return { ok: true, price, stopLoss: sl, takeProfit: tp };
}

/** HTTP status for a refused pending-control draft. */
export function pendingControlRefusalStatus(reason: string): number {
  if (reason === "PENDING_ORDER_NOT_FOUND") return 404;
  if (reason === "PENDING_ORDER_NOT_OWNED") return 404; // never confirm another user's order exists
  if (/^(INVALID_|NO_CHANGES|MISSING_PENDING_PRICE|MISSING_STOP_LIMIT_PRICE|PENDING_PRICE_WRONG_SIDE|STOP_LIMIT_PRICE_WRONG_SIDE|STOP_LOSS_WRONG_SIDE|TAKE_PROFIT_WRONG_SIDE|NOT_A_PENDING_ORDER|UNKNOWN_ORDER_TYPE|ORDER_TYPE_SIDE_MISMATCH)/.test(reason)) return 400;
  return 409;
}

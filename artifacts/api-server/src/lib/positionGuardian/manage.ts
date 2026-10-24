// Position Guardian — the one exit door for post-entry management.
//
// Every acting guardian rule (lib/positionGuardian/rules.ts) reaches an
// execution path only through this module. Each request is checked against
// the registry before anything is sent:
//
//   1. the rule is registered and ACTING (an advisory rule cannot act),
//   2. the action is one the rule is registered for, on its registered route,
//   3. a stop move never widens: break-even and trailing only tighten.
//
// The request then goes to the existing governed path for its route, which
// still runs its own checks (Risk Governor, kill switch, dispatch gates). This
// module writes no table itself, never opens a position and never adds size:
// none of those actions exist in the registry.

import { isStopWidened } from "../riskGovernor/preTrade.js";
import { logger } from "../logger.js";
import type { GovernedOpResult, GovernedPosition } from "../positions/governedOps.js";
import type { InstantTradeIntent, InstantTradeResult } from "../live/instantTrade.js";
import type { ConfirmResult } from "../tradeAction/confirm.js";
import type { PaperManagementStep, PaperTrade } from "../trades/paperBook.js";
import {
  guardianRule,
  type GuardianManagementAction,
  type GuardianRoute,
  type GuardianRuleId,
} from "./rules.js";

export type GuardianRefusalCode =
  | "RULE_NOT_REGISTERED"
  | "RULE_IS_ADVISORY"
  | "ACTION_NOT_REGISTERED"
  | "ROUTE_NOT_REGISTERED"
  | "STOP_WOULD_WIDEN"
  | "UNSUPPORTED_ACTION";

export type GuardianAuthorization =
  | { ok: true }
  | { ok: false; code: GuardianRefusalCode; reason: string };

export interface StopContext {
  side: "BUY" | "SELL";
  /** The stop the position holds now; null when it has none. */
  currentStop: number | null;
  nextStop: number | null;
}

/** Pure registry check. Exported for tests and for callers that pre-flight. */
export function authorizeManagement(
  ruleId: string,
  action: GuardianManagementAction,
  route: GuardianRoute,
  stop?: StopContext,
): GuardianAuthorization {
  const rule = guardianRule(ruleId);
  if (!rule) return { ok: false, code: "RULE_NOT_REGISTERED", reason: `"${ruleId}" is not a registered Position Guardian rule.` };
  if (rule.kind !== "ACTING") {
    return { ok: false, code: "RULE_IS_ADVISORY", reason: `${rule.label} is advisory and cannot change a position.` };
  }
  if (!rule.actions.includes(action)) {
    return { ok: false, code: "ACTION_NOT_REGISTERED", reason: `${rule.label} is not registered to ${action}.` };
  }
  if (rule.route !== route) {
    return { ok: false, code: "ROUTE_NOT_REGISTERED", reason: `${rule.label} acts through ${rule.route}, not ${route}.` };
  }
  if (action === "MOVE_STOP") {
    // A position with no stop has unbounded risk, so any stop tightens it.
    // A move to "no stop" always widens.
    if (!stop || stop.nextStop == null || !Number.isFinite(stop.nextStop)) {
      return { ok: false, code: "STOP_WOULD_WIDEN", reason: "Removing a stop would add risk; the guardian only tightens." };
    }
    if (stop.currentStop != null && isStopWidened(stop.side, stop.currentStop, stop.nextStop)) {
      return {
        ok: false,
        code: "STOP_WOULD_WIDEN",
        reason: `Moving the stop from ${stop.currentStop} to ${stop.nextStop} would add risk; break-even and trailing only tighten.`,
      };
    }
  }
  return { ok: true };
}

function refused(ruleId: string, userId: number | null, auth: Extract<GuardianAuthorization, { ok: false }>): void {
  logger.warn({ ruleId, userId, code: auth.code, reason: auth.reason }, "[position-guardian] management request refused");
}

// ── GOVERNED_OPS: the guardian's own stop restore ───────────────────────────

/** Restore the governed stop through the Trade Engine (MODIFY → governedOps → the venue queue). */
export async function guardianRestoreStop(args: {
  ruleId: GuardianRuleId;
  userId: number;
  position: GovernedPosition;
  stopLoss: number;
  takeProfit: number | null;
  sourcePage: string;
}): Promise<GovernedOpResult> {
  const auth = authorizeManagement(args.ruleId, "RESTORE_STOP", "GOVERNED_OPS");
  if (!auth.ok) {
    refused(args.ruleId, args.userId, auth);
    return { ok: false, commandId: null, reason: auth.code };
  }
  // The Trade Engine's MODIFY intent on an already-resolved governed position:
  // the mode is the position's own venue, so the pipeline goes straight to
  // governedOps.submitGovernedModify with these arguments.
  const { submitTrade } = await import("../tradeEngine/pipeline.js");
  const res = await submitTrade({
    mode: args.position.venue, intent: "MODIFY", userId: args.userId,
    target: { position: args.position },
    stopLoss: args.stopLoss, takeProfit: args.takeProfit, sourcePage: args.sourcePage,
  });
  return res.ok
    ? { ok: true, commandId: res.commandId, reason: null }
    : { ok: false, commandId: res.commandId, reason: res.reason };
}

// ── TRADE_ACTION_CENTER: draft → confirm (venue queues, #26/#27) ─────────────

export interface GuardianTradeActionResult {
  authorized: boolean;
  refusal: GuardianRefusalCode | null;
  actionId: number | null;
  /** True once a confirm was attempted on a created draft. */
  attempted: boolean;
  confirmed: ConfirmResult | null;
  error: string | null;
}

/** Close (all of, or `closePercent` of) a trade through the Trade Action Center. */
export async function guardianTradeActionClose(args: {
  ruleId: GuardianRuleId;
  userId: number;
  tradeKey: string;
  closePercent: number;
  reason: string;
}): Promise<GuardianTradeActionResult> {
  const action: GuardianManagementAction = args.closePercent >= 100 ? "CLOSE" : "PARTIAL_CLOSE";
  const auth = authorizeManagement(args.ruleId, action, "TRADE_ACTION_CENTER");
  if (!auth.ok) {
    refused(args.ruleId, args.userId, auth);
    return { authorized: false, refusal: auth.code, actionId: null, attempted: false, confirmed: null, error: auth.reason };
  }
  const { createActionDraft } = await import("../tradeAction/create.js");
  const { confirmAction } = await import("../tradeAction/confirm.js");
  const created = await createActionDraft({
    userId: args.userId,
    actionType: action,
    tradeKey: args.tradeKey,
    requestedMode: "SIMULATED",
    reason: args.reason,
    source: "decision_engine",
  });
  if (!created.ok) {
    return { authorized: true, refusal: null, actionId: null, attempted: false, confirmed: null, error: created.error };
  }
  const confirmed = await confirmAction({ userId: args.userId, actionId: created.action.id, liveConfirmPhrase: null });
  return {
    authorized: true,
    refusal: null,
    actionId: created.action.id,
    attempted: true,
    confirmed,
    error: confirmed.ok ? null : confirmed.error,
  };
}

// ── INSTANT_ROUTER: the Trade Engine one-click leg (submitInstantTrade →
//    executeInstant, 18-gate Phase B dispatch) ─────────────────────────────

export type GuardianInstantExecutor = (args: {
  userId: number;
  intent: InstantTradeIntent;
  ip?: string | null;
  ua?: string | null;
}) => Promise<InstantTradeResult>;

/** The registry action an instant-router intent amounts to, or null if it is not management. */
export function instantIntentAction(
  intent: InstantTradeIntent,
  position: { stopLoss: number | null; takeProfit: number | null },
): GuardianManagementAction | null {
  if (intent.action === "CLOSE") return intent.closeVolume != null ? "PARTIAL_CLOSE" : "CLOSE";
  if (intent.action !== "MODIFY_SL_TP") return null;
  const stopChanges = (intent.newStopLoss ?? null) !== position.stopLoss;
  if (stopChanges) return "MOVE_STOP";
  return (intent.newTakeProfit ?? null) !== position.takeProfit ? "MOVE_TARGET" : null;
}

/**
 * Route a management intent for an open position through the instant-trade
 * router. `executor` defaults to the Trade Engine one-click entry
 * (pipeline.submitInstantTrade → executeInstant); tests substitute a spy.
 */
export async function guardianInstantManage(args: {
  ruleId: GuardianRuleId;
  userId: number;
  intent: InstantTradeIntent;
  position: { side: "BUY" | "SELL"; stopLoss: number | null; takeProfit: number | null };
  executor?: GuardianInstantExecutor;
  ip?: string | null;
  ua?: string | null;
}): Promise<InstantTradeResult> {
  const action = instantIntentAction(args.intent, args.position);
  const auth: GuardianAuthorization = action == null
    ? { ok: false, code: "UNSUPPORTED_ACTION", reason: `${args.intent.action} is not a position-management action.` }
    : authorizeManagement(args.ruleId, action, "INSTANT_ROUTER", {
        side: args.position.side,
        currentStop: args.position.stopLoss,
        nextStop: args.intent.newStopLoss ?? null,
      });
  if (!auth.ok) {
    refused(args.ruleId, args.userId, auth);
    return { ok: false, httpStatus: 409, error: auth.code, primaryReason: auth.reason };
  }
  const executor = args.executor ?? (await import("../tradeEngine/pipeline.js")).submitInstantTrade;
  return executor({ userId: args.userId, intent: args.intent, ip: args.ip, ua: args.ua });
}

// ── PAPER_BOOK: simulated trades (no broker) ────────────────────────────────

export type GuardianPaperOp = PaperManagementStep;

export type GuardianPaperResult =
  | { ok: true; trade: PaperTrade }
  | { ok: false; code: GuardianRefusalCode | "TRADE_NOT_FOUND"; reason: string };

/** Apply a management step to a simulated trade the caller has already scoped to its owner. */
export async function guardianPaperManage(args: {
  ruleId: GuardianRuleId;
  trade: PaperTrade;
  op: GuardianPaperOp;
}): Promise<GuardianPaperResult> {
  const { trade, op } = args;
  const side = trade.direction === "SELL" ? "SELL" : "BUY";
  if (op.kind === "PARTIAL_CLOSE" && !(op.newLot < trade.lot)) {
    return { ok: false, code: "UNSUPPORTED_ACTION", reason: `A partial close must reduce size below ${trade.lot} lots.` };
  }
  const auth = authorizeManagement(args.ruleId, op.kind, "PAPER_BOOK",
    op.kind === "MOVE_STOP" ? { side, currentStop: trade.stopLoss, nextStop: op.newStop } : undefined);
  if (!auth.ok) {
    refused(args.ruleId, trade.userId ?? null, auth);
    return { ok: false, code: auth.code, reason: auth.reason };
  }
  const { applyPaperManagement } = await import("../trades/paperBook.js");
  const row = await applyPaperManagement(trade.id, op);
  if (!row) return { ok: false, code: "TRADE_NOT_FOUND", reason: `Trade ${trade.id} no longer exists.` };
  return { ok: true, trade: row };
}

// Trade Action → pre-trade Risk Governor adapter.
//
// Maps a Trade Action Center request onto a TradeIntent and hands it to the
// one Risk Governor (lib/riskGovernor/enforce.ts), which decides every limit:
//   * the 12 exposure rules and the stop switches,
//   * rule 13: max open trades, max trades per day (trader, legacy and admin
//     caps, strictest wins) and the trader's discipline settings,
//   * admin account type, instrument allow-list and direction,
//   * daily loss / drawdown (close-only: closes and tightening stay allowed),
//   * shared-master allocation (suspended, exhausted, unsized P/L, margin).
//
// It is invoked from `runActionGuards` AFTER the lot-cap check and BEFORE
// the duplicate / queueable checks. The governor writes the user_risk_events
// row; this adapter only adds a routing precondition (shared-master routing
// must name a virtual allocation).
//
// HARD RULES:
//   * Fail-closed: any DB error in a hard-check path returns "block".
//   * Never fabricates balance or P&L. If the required data row is
//     missing it falls back to the SAFE default (block on uncertain
//     LIVE-routing checks, pass on advisory limits).
//   * Never bypasses an existing guard — only ADDS checks.
//   * Never queues or modifies an MT5 command.

import { logRiskEvent } from "../riskGovernor/riskEvents.js";
import { enforcePreTradeRisk, type IntentAction, type IntentOrigin } from "../riskGovernor/enforce.js";

// ── Action classification ───────────────────────────────────────────────────
const OPENS_NEW_RISK = new Set(["OPEN"]);
const REDUCES_RISK = new Set(["CLOSE", "PARTIAL_CLOSE"]);
const MODIFIES = new Set(["MOVE_STOP", "TRAIL_STOP", "MODIFY_TP_SL"]);

export interface RiskEnforcementInput {
  userId: number;
  actionId: number;
  actionType: string;
  requestedMode: "SIMULATED" | "DEMO" | "LIVE";
  symbol: string;
  side: string | null;             // "BUY" | "SELL" | null
  lotSize: number | null;
  /** Order prices, so the 12 pre-trade rules can measure loss at stop. */
  requestedPrice?: number | null;
  stopLoss?: number | null;
  takeProfit?: number | null;
  /** Who originated the draft (user, Ruby, decision engine). */
  origin?: IntentOrigin;
  /** The trade a modify acts on, so the Position Guardian can tell a widened stop from a tightened one. */
  position?: { side: "BUY" | "SELL"; entryPrice: number | null; stopLoss: number | null; lotSize: number } | null;
  routingMode: string | null;      // "USER_OWNED_MT5" | "SHARED_MASTER_MT5"
  /** Bridge the action routes to (routingResolver); null = the user's own. */
  connectionId?: number | null;
  virtualAccountId: number | null; // populated by routingResolver in SHARED mode
  /**
   * Phase OR2 — when called from the Opportunity Radar preview path, the
   * full Risk Governor check still runs but BLOCK decisions are NOT
   * persisted to user_risk_events. The block decision is still returned
   * so radar can label the opportunity BLOCKED_BY_RULE.
   */
  previewMode?: boolean;
  /** OR2 P1 #2 — per-scan cache forwarded from runActionGuards. */
  prefetched?: {
    riskSettings?: { maxLotSize?: number | null; liveDisclosureAcknowledgedAt?: Date | null } | null;
  };
}

export interface RiskEnforcementResult {
  passed: boolean;
  /** Stable check id for the guard ledger ("rg_close_only", "rg_daily_loss", …) */
  checkId: string;
  /** Human-readable reason on block. Null on pass. */
  reason: string | null;
  /** Structured detail for AI tools / audit. */
  details: Record<string, unknown>;
}

const ok = (checkId: string, details: Record<string, unknown> = {}): RiskEnforcementResult =>
  ({ passed: true, checkId, reason: null, details });

async function blockAndLog(
  userId: number,
  checkId: string,
  reason: string,
  details: Record<string, unknown>,
  actionId: number,
  previewMode?: boolean,
): Promise<RiskEnforcementResult> {
  // Phase OR2 — Opportunity Radar previews share this exact check chain but
  // must NOT pollute user_risk_events with a "blocked_trade" row per scan.
  // The decision is still returned so radar can label the opportunity.
  if (!previewMode) {
    try {
      await logRiskEvent({
        userId,
        eventType: "blocked_trade",
        severity: "critical",
        decision: "block",
        reason,
        details: { ...details, source: "risk_governor_enforcement", checkId, actionId },
      });
    } catch {
      // Never break the guard path on logging failure.
    }
  }
  return { passed: false, checkId, reason, details };
}

// ── Main enforcement entrypoint ────────────────────────────────────────────
export async function enforceRiskGovernor(input: RiskEnforcementInput): Promise<RiskEnforcementResult> {
  const { userId, actionType, requestedMode, symbol, side, lotSize, routingMode, virtualAccountId } = input;

  // 0. The 13 mandatory pre-trade rules (lib/riskGovernor) run for EVERY
  //    mode, SIMULATED included: demo exercises the same rules as live.
  //    enforcePreTradeRisk writes its own user_risk_events row. A radar
  //    preview with no lot size yet cannot be sized, so it is checked when
  //    the real draft is confirmed instead.
  const intentAction = toIntentAction(actionType);
  // A modify that leaves a level out keeps the trade's current one.
  const pos = intentAction === "MODIFY" ? input.position ?? null : null;
  if (intentAction && !(input.previewMode && lotSize == null && !pos)) {
    const pre = await enforcePreTradeRisk({
      userId,
      venue: requestedMode === "SIMULATED" ? "PAPER" : requestedMode,
      origin: input.origin ?? "manual",
      action: intentAction,
      symbol,
      side: side === "BUY" || side === "SELL" ? side : pos?.side ?? null,
      lots: lotSize ?? pos?.lotSize ?? null,
      entryPrice: input.requestedPrice ?? null,
      stopLoss: input.stopLoss ?? pos?.stopLoss ?? null,
      takeProfit: input.takeProfit ?? null,
      intentRef: `trade_action:${input.actionId}`,
      position: pos && pos.entryPrice != null ? { entryPrice: pos.entryPrice, stopLoss: pos.stopLoss } : null,
    }, {
      preview: input.previewMode,
      connectionId: input.connectionId ?? null,
      virtualAccountId: routingMode === "SHARED_MASTER_MT5" ? virtualAccountId : null,
      auditContext: { caller: "trade_action_guards", actionId: input.actionId, requestedMode },
    });
    if (!pre.allowed) {
      return {
        passed: false,
        checkId: `rg_${pre.blockedBy[0] ?? "audit_unavailable"}`,
        reason: pre.primaryReason ?? "Blocked by Risk Governor.",
        details: { blockedBy: pre.blockedBy, auditEventId: pre.auditEventId, rules: pre.rules },
      };
    }
  }

  // Routing precondition: shared-master routing must name the trader's
  // virtual allocation, or the governor would size against the wrong account.
  if (routingMode === "SHARED_MASTER_MT5" && OPENS_NEW_RISK.has(actionType) && virtualAccountId == null) {
    return blockAndLog(userId, "rg_shared_no_virtual_account",
      "Shared-master routing requires a virtual allocation. Contact admin.",
      { routingMode }, input.actionId, input.previewMode);
  }

  // Every limit (account type, instruments, direction, daily loss and
  // close-only, open-trade and trades-per-day caps, shared allocation) is
  // decided by the Risk Governor above. Nothing else here can refuse.
  return ok("rg_passed", { actionType, requestedMode, routingMode });
}

function toIntentAction(actionType: string): IntentAction | null {
  if (actionType === "OPEN") return "OPEN";
  if (actionType === "CLOSE" || actionType === "PARTIAL_CLOSE") return actionType;
  if (MODIFIES.has(actionType)) return "MODIFY";
  return null; // CANCEL_ORDER removes a pending order; it adds no risk.
}

// Re-exports for callers that want classification without re-importing.
export const RG_CLASSIFY = { OPENS_NEW_RISK, REDUCES_RISK, MODIFIES };

// ── Phase TT — Trade-ticket price-level hard guards ────────────────────────
//
// These guards run BEFORE the existing enforceRiskGovernor chain (which is
// account-level: caps, daily loss, allocations). They enforce price-level
// integrity: RR floor, min-stop distance, pending-order direction relative
// to current market, and stop-limit trigger/limit consistency.
//
// SAFETY:
//   * Pure DB-free function — does NOT log to user_risk_events. The caller
//     (pending-order-draft route) decides whether to log a block.
//   * Returns the first failing check. Never bypasses validateOrderTicket —
//     wraps it and adds the configurable RR floor on top.
//   * SIMULATED actions still get the ticket validation (so draft previews
//     surface direction errors), but RR-floor blocks are skipped.
import { validateOrderTicket, type OrderTicketInput, type OrderTicketValidation } from "./orderTicketValidation.js";
import type { OrderType } from "./orderTypes.js";

export interface TradeTicketEnforcementInput extends OrderTicketInput {
  userId: number;
  requestedMode: "SIMULATED" | "DEMO" | "LIVE";
  minRiskRewardRatio?: number | null; // user/admin setting; 0 or null = disabled
}

export interface TradeTicketEnforcementResult {
  passed: boolean;
  checkId: string;            // rg_ticket_validation | rg_rr_ratio_min | rg_stop_limit_relationship | rg_passed_ticket
  reason: string | null;
  validation: OrderTicketValidation;
}

export function enforceTradeTicketRules(input: TradeTicketEnforcementInput): TradeTicketEnforcementResult {
  const validation = validateOrderTicket(input);

  if (!validation.ok) {
    // First validation error becomes the primary block reason. Note the
    // check id maps the ENTIRE validation pass — individual sub-rules
    // (pending-order direction, SL/TP direction, min-stop distance,
    // stop-limit trigger/limit relationship) are all rolled up here so
    // the audit ledger and AI tools can read validation.errors directly.
    return {
      passed: false,
      checkId: "rg_ticket_validation",
      reason: validation.errors[0] ?? "Trade ticket validation failed.",
      validation,
    };
  }

  // RR floor only enforced when explicitly set AND we have both SL + TP.
  if (input.requestedMode !== "SIMULATED"
      && input.minRiskRewardRatio != null
      && input.minRiskRewardRatio > 0
      && validation.riskReward != null
      && validation.riskReward < input.minRiskRewardRatio) {
    return {
      passed: false,
      checkId: "rg_rr_ratio_min",
      reason: `Risk/Reward ${validation.riskReward.toFixed(2)} is below your minimum of ${input.minRiskRewardRatio}.`,
      validation,
    };
  }

  return { passed: true, checkId: "rg_passed_ticket", reason: null, validation };
}

export type { OrderType };

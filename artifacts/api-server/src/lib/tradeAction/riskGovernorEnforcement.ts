// Phase RG — Central Risk Governor enforcement for the Trade Action chokepoint.
//
// This module is the ONE place that enforces:
//   * max open trades             (user_risk_settings.maxOpenTrades)
//   * max trades per day          (user_risk_settings.maxTradesPerDay; also user_risk_limits.maxTradesPerDay if admin-set)
//   * daily loss limit            (user_risk_settings.maxDailyLossPercent / maxDailyLossAmount; also user_risk_limits.maxDailyLossUsd)
//   * close-only mode             (daily loss hit OR user_risk_limits.requireLiveConfirmation-style admin pause)
//   * shared-master allocation    (virtual_trading_accounts.virtualBalance / virtualPnl caps)
//   * allowed symbols             (user_risk_limits.allowedSymbols)
//   * allowed direction           (user_risk_limits.allowedDirection)
//
// It is invoked from `runActionGuards` AFTER the lot-cap check and BEFORE
// the duplicate / queueable checks. Every BLOCK is logged to
// `user_risk_events` via the existing `logRiskEvent` helper. Reads are
// strictly scoped to the requesting user — no cross-user state ever.
//
// HARD RULES:
//   * Fail-closed: any DB error in a hard-check path returns "block".
//   * Never fabricates balance or P&L. If the required data row is
//     missing it falls back to the SAFE default (block on uncertain
//     LIVE-routing checks, pass on advisory limits).
//   * Never bypasses an existing guard — only ADDS checks.
//   * Never queues or modifies an MT5 command.

import { db } from "@workspace/db";
import {
  userRiskSettingsTable,
  userRiskLimitsTable,
  livePositionsTable,
  tradesTable,
  virtualTradingAccountsTable,
} from "@workspace/db/schema";
import { and, desc, eq, gte, ne, sql } from "drizzle-orm";
import { logRiskEvent } from "../../routes/meRiskGovernor.js";

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
  routingMode: string | null;      // "USER_OWNED_MT5" | "SHARED_MASTER_MT5"
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

// ── Helpers ────────────────────────────────────────────────────────────────
function startOfTodayUtc(now = new Date()): Date {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

async function countTodayOpenedTrades(userId: number): Promise<number> {
  const since = startOfTodayUtc();
  const [row] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(tradesTable)
    .where(and(eq(tradesTable.userId, userId), gte(tradesTable.createdAt, since)));
  return Number(row?.c ?? 0);
}

async function countOpenLivePositions(userId: number): Promise<number> {
  const [row] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(livePositionsTable)
    .where(and(eq(livePositionsTable.userId, userId), ne(livePositionsTable.status, "CLOSED")));
  return Number(row?.c ?? 0);
}

async function sumTodayRealizedPnl(userId: number): Promise<number> {
  const since = startOfTodayUtc();
  const [row] = await db
    .select({ s: sql<number>`coalesce(sum(pnl), 0)::float8` })
    .from(tradesTable)
    .where(and(
      eq(tradesTable.userId, userId),
      gte(tradesTable.closedAt, since),
    ));
  return Number(row?.s ?? 0);
}

// ── Main enforcement entrypoint ────────────────────────────────────────────
export async function enforceRiskGovernor(input: RiskEnforcementInput): Promise<RiskEnforcementResult> {
  const { userId, actionType, requestedMode, symbol, side, lotSize, routingMode, virtualAccountId } = input;

  // SIMULATED actions never touch the broker — skip enforcement (still
  // advisory through evaluateRiskCheck on the precheck route).
  if (requestedMode === "SIMULATED") {
    return ok("rg_skipped_simulated");
  }

  // 1. Load per-user risk settings (advisory caps) and admin-set hard limits.
  //    Both are optional rows — if absent we fall back to engine defaults.
  let settingsRow: typeof userRiskSettingsTable.$inferSelect | undefined;
  let limitsRow: typeof userRiskLimitsTable.$inferSelect | undefined;
  try {
    const [s] = await db.select().from(userRiskSettingsTable)
      .where(eq(userRiskSettingsTable.userId, userId)).limit(1);
    settingsRow = s;
    const [l] = await db.select().from(userRiskLimitsTable)
      .where(eq(userRiskLimitsTable.userId, userId)).limit(1);
    limitsRow = l;
  } catch (e) {
    return blockAndLog(userId, "rg_settings_load_failed",
      "Risk settings could not be loaded. Trade blocked for safety.",
      { error: (e as Error).message }, input.actionId, input.previewMode);
  }

  const maxOpenTrades = settingsRow?.maxOpenTrades ?? 3;
  const maxTradesPerDaySettings = settingsRow?.maxTradesPerDay ?? 5;
  const maxTradesPerDayAdmin = limitsRow?.maxTradesPerDay ?? 0; // 0 = unlimited
  const maxDailyLossPercent = settingsRow?.maxDailyLossPercent ?? 3;
  const maxDailyLossAmountSettings = settingsRow?.maxDailyLossAmount ?? null;
  const maxDailyLossAdminUsd = limitsRow?.maxDailyLossUsd ?? 0; // 0 = unlimited
  const blockAfterDailyLossHit = settingsRow?.blockAfterDailyLossHit ?? true;
  const allowedSymbols = Array.isArray(limitsRow?.allowedSymbols) ? (limitsRow.allowedSymbols as string[]) : [];
  const allowedDirection = (limitsRow?.allowedDirection ?? "both") as string;
  const allowedAccountType = (limitsRow?.allowedAccountType ?? "demo") as string;

  // 2. Admin allowedAccountType gate.
  if (requestedMode === "LIVE" && allowedAccountType === "demo") {
    return blockAndLog(userId, "rg_admin_account_type",
      "Your account is restricted to DEMO trading by admin policy.",
      { allowedAccountType }, input.actionId, input.previewMode);
  }

  // 3. Allowed symbols / direction (admin policy). Empty list = unrestricted.
  if (OPENS_NEW_RISK.has(actionType)) {
    if (allowedSymbols.length > 0 && !allowedSymbols.includes(symbol)) {
      return blockAndLog(userId, "rg_symbol_blocked",
        `Symbol ${symbol} is not on your allowed symbol list.`,
        { allowedSymbols }, input.actionId, input.previewMode);
    }
    if (side && allowedDirection !== "both") {
      const wantDir = side === "BUY" ? "buy" : "sell";
      if (wantDir !== allowedDirection) {
        return blockAndLog(userId, "rg_direction_blocked",
          `Your account is restricted to ${allowedDirection.toUpperCase()} trades only.`,
          { allowedDirection, requestedSide: side }, input.actionId, input.previewMode);
      }
    }
  }

  // 4. Daily loss limit (drives close-only mode).
  //    We only block NEW risk (OPEN). CLOSE / PARTIAL_CLOSE / MODIFIES are
  //    always allowed if they reduce or manage existing risk.
  let inCloseOnlyMode = false;
  let closeOnlyReason = "";
  if (blockAfterDailyLossHit) {
    let dailyPnl = 0;
    try { dailyPnl = await sumTodayRealizedPnl(userId); }
    catch (e) {
      return blockAndLog(userId, "rg_daily_pnl_unavailable",
        "Daily P&L could not be computed. Trade blocked for safety.",
        { error: (e as Error).message }, input.actionId, input.previewMode);
    }

    // 4a. Admin hard USD cap (most restrictive — applies even without balance).
    if (maxDailyLossAdminUsd > 0 && dailyPnl <= -maxDailyLossAdminUsd) {
      inCloseOnlyMode = true;
      closeOnlyReason = `Admin daily-loss cap hit ($${maxDailyLossAdminUsd}). Account is in CLOSE-ONLY mode.`;
    }
    // 4b. Engine USD cap (user-set absolute amount).
    if (!inCloseOnlyMode && maxDailyLossAmountSettings != null && dailyPnl <= -maxDailyLossAmountSettings) {
      inCloseOnlyMode = true;
      closeOnlyReason = `Daily loss cap hit ($${maxDailyLossAmountSettings}). CLOSE-ONLY mode until midnight UTC.`;
    }
    // 4c. Percent cap — needs an account balance. Task #430: source the equity
    //     base AND floating P/L from the canonical mark-to-market snapshot so
    //     the percent cap is measured against the SAME live equity the user
    //     sees everywhere, and so a current floating drawdown also counts toward
    //     the daily-loss percentage (stricter — never looser). Falls back to the
    //     virtual-balance row when the canonical snapshot is unavailable; never
    //     fabricates a balance (skip rather than invent one).
    if (!inCloseOnlyMode && routingMode === "SHARED_MASTER_MT5" && virtualAccountId != null) {
      let equityBase: number | null = null;
      let floatingLoss = 0;
      try {
        const { buildInvestorLiveBalanceSnapshot } = await import("../live/investorLiveBalance.js");
        const inv = await buildInvestorLiveBalanceSnapshot(userId);
        if (inv.allocatedBalance > 0) equityBase = inv.allocatedBalance;
        // floatingPnL null = unavailable → realized-only (never 0-faked).
        if (inv.floatingPnL != null && inv.floatingPnL < 0) floatingLoss = inv.floatingPnL;
      } catch {
        // canonical snapshot unavailable — fall back to the virtual-balance row.
      }
      if (equityBase == null) {
        try {
          const [v] = await db.select().from(virtualTradingAccountsTable)
            .where(eq(virtualTradingAccountsTable.id, virtualAccountId)).limit(1);
          if (v && v.virtualBalance > 0) equityBase = v.virtualBalance;
        } catch {
          // virtual account read is non-critical for this branch
        }
      }
      if (equityBase != null && equityBase > 0) {
        const combinedDailyPnl = dailyPnl + floatingLoss;
        const lossPct = combinedDailyPnl < 0 ? (Math.abs(combinedDailyPnl) / equityBase) * 100 : 0;
        if (lossPct >= maxDailyLossPercent) {
          inCloseOnlyMode = true;
          closeOnlyReason = `Daily loss ${lossPct.toFixed(2)}% ≥ cap ${maxDailyLossPercent}%. CLOSE-ONLY mode.`;
        }
      }
    }
  }

  if (inCloseOnlyMode && OPENS_NEW_RISK.has(actionType)) {
    return blockAndLog(userId, "rg_close_only_mode", closeOnlyReason,
      { dailyLossHit: true, action: actionType }, input.actionId, input.previewMode);
  }
  // CLOSE / PARTIAL_CLOSE / MODIFY pass through in close-only mode.

  // 5. Max open trades — only applies to new-risk actions.
  if (OPENS_NEW_RISK.has(actionType)) {
    let openCount = 0;
    try { openCount = await countOpenLivePositions(userId); }
    catch (e) {
      return blockAndLog(userId, "rg_open_count_unavailable",
        "Open position count unavailable. Trade blocked for safety.",
        { error: (e as Error).message }, input.actionId, input.previewMode);
    }
    if (openCount >= maxOpenTrades) {
      return blockAndLog(userId, "rg_max_open_trades",
        `You already have ${openCount} open trade${openCount === 1 ? "" : "s"} (limit ${maxOpenTrades}). Close one to open another.`,
        { openCount, maxOpenTrades }, input.actionId, input.previewMode);
    }
  }

  // 6. Max trades per day — only applies to new-risk actions.
  //    Admin cap (if > 0) is the floor; engine setting is the ceiling.
  if (OPENS_NEW_RISK.has(actionType)) {
    let tradesToday = 0;
    try { tradesToday = await countTodayOpenedTrades(userId); }
    catch (e) {
      return blockAndLog(userId, "rg_trade_count_unavailable",
        "Daily trade count unavailable. Trade blocked for safety.",
        { error: (e as Error).message }, input.actionId, input.previewMode);
    }
    const effectiveDailyCap = maxTradesPerDayAdmin > 0
      ? Math.min(maxTradesPerDayAdmin, maxTradesPerDaySettings)
      : maxTradesPerDaySettings;
    if (tradesToday >= effectiveDailyCap) {
      return blockAndLog(userId, "rg_max_trades_per_day",
        `Daily trade cap reached (${tradesToday}/${effectiveDailyCap}). Resume tomorrow.`,
        { tradesToday, effectiveDailyCap, adminCap: maxTradesPerDayAdmin, settingsCap: maxTradesPerDaySettings }, input.actionId, input.previewMode);
    }
  }

  // 7. Shared-master virtual allocation cap.
  if (routingMode === "SHARED_MASTER_MT5" && OPENS_NEW_RISK.has(actionType)) {
    if (virtualAccountId == null) {
      return blockAndLog(userId, "rg_shared_no_virtual_account",
        "Shared-master routing requires a virtual allocation. Contact admin.",
        { routingMode }, input.actionId, input.previewMode);
    }
    try {
      const [v] = await db.select().from(virtualTradingAccountsTable)
        .where(and(
          eq(virtualTradingAccountsTable.id, virtualAccountId),
          eq(virtualTradingAccountsTable.userId, userId), // scope: user must own this virtual account
        )).limit(1);
      if (!v) {
        return blockAndLog(userId, "rg_shared_virtual_not_owned",
          "Your virtual allocation could not be verified. Trade blocked.",
          { virtualAccountId }, input.actionId, input.previewMode);
      }
      if (v.status !== "active") {
        return blockAndLog(userId, "rg_shared_virtual_suspended",
          `Your shared-master allocation is ${v.status}. New trades are blocked.`,
          { status: v.status }, input.actionId, input.previewMode);
      }
      // Allocation cap: if virtualBalance is set and virtualPnl already
      // exceeds the negative of it (i.e. blown the allocation), block.
      if (v.virtualBalance > 0 && v.virtualPnl <= -v.virtualBalance) {
        return blockAndLog(userId, "rg_shared_allocation_blown",
          "Your virtual allocation has been exhausted. CLOSE-ONLY until reset.",
          { virtualBalance: v.virtualBalance, virtualPnl: v.virtualPnl }, input.actionId, input.previewMode);
      }
      // Soft check: per-trade lot vs virtualBalance proxy. Reject if a
      // single new trade would put margin used > virtualBalance (uses
      // 100:1 leverage proxy when broker margin specs unavailable — flag
      // as approximate, never as authoritative).
      if (lotSize != null && lotSize > 0 && v.virtualBalance > 0) {
        const approxNotional = lotSize * 100_000; // 1 std lot ≈ 100k base ccy notional
        const approxMarginAt100x = approxNotional / 100;
        const projectedMarginUsed = v.virtualMarginUsed + approxMarginAt100x;
        if (projectedMarginUsed > v.virtualBalance) {
          return blockAndLog(userId, "rg_shared_margin_would_exceed",
            "This trade would exceed your virtual allocation (margin estimate). Reduce lot size.",
            {
              virtualBalance: v.virtualBalance,
              virtualMarginUsed: v.virtualMarginUsed,
              approxMarginAt100x,
              note: "approx_margin_no_broker_specs",
            }, input.actionId, input.previewMode);
        }
      }
    } catch (e) {
      return blockAndLog(userId, "rg_shared_lookup_failed",
        "Virtual allocation check failed. Trade blocked for safety.",
        { error: (e as Error).message }, input.actionId, input.previewMode);
    }
  }

  // All checks passed — record an advisory ledger entry (info only).
  return ok("rg_passed", {
    actionType,
    requestedMode,
    routingMode,
    inCloseOnlyMode,
    maxOpenTrades,
    maxTradesPerDay: maxTradesPerDayAdmin > 0
      ? Math.min(maxTradesPerDayAdmin, maxTradesPerDaySettings)
      : maxTradesPerDaySettings,
  });
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

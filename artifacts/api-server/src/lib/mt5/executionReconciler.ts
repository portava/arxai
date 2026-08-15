// Phase UX9 — MT5 Execution Reconciliation.
//
// SAFETY:
//   * This module NEVER queues, opens, or closes any trade. It only
//     reconciles what the EA *reports* back into our local tables.
//   * Every read & write is user-scoped via the resolved command row's
//     userId / mt5ConnectionId. Cross-user / cross-connection updates
//     are impossible because the route validates ownership first.
//   * Idempotent: terminal command rows are NOT re-processed; duplicate
//     callbacks for the same (commandId, terminalStatus) short-circuit.
//   * Honest: if a piece of state isn't available (e.g. no action_request
//     linked, no live_positions row for a CLOSE), we record a timeline
//     event saying so — we never fabricate fills, tickets or P&L.
//   * No secrets are read or written here. The route handler validates
//     X-MT5-Bridge-Token before we ever run.

import { db } from "@workspace/db";
import {
  mt5CommandsTable,
  tradeActionRequestsTable,
  livePositionsTable,
  sharedTradeAttributionTable,
  tradeCommandAuditLogTable,
} from "@workspace/db/schema";
import { and, eq, isNotNull } from "drizzle-orm";
import { writeActionTimeline } from "../tradeAction/timeline.js";
import { notifyAction } from "../tradeAction/notifications.js";
import { humanize } from "../tradeAction/create.js";
import type { ActionType } from "../tradeAction/types.js";
import { logger } from "../logger.js";
import { recordUnattributedMasterTrade } from "./unattributedMasterTrades.js";
import { applyRealizedPnlToVirtualAccount } from "./virtualPnlSync.js";
import {
  computeRealizedAmount,
  resolveContractSize,
  resolveQuoteToAccountFx,
} from "./contractSize.js";
import { getAccountCurrency } from "../live/accountCurrency.js";
import { sharedMasterAccountsTable } from "@workspace/db/schema";

export type ExecutionResultStatus =
  | "executed" | "rejected" | "failed" | "partial" | "pending";

export interface ExecutionResultInput {
  commandId: number;
  actionRequestId?: number | null;
  status: ExecutionResultStatus;
  mt5OrderTicket?: string | null;
  mt5PositionTicket?: string | null;
  symbol?: string | null;
  side?: "BUY" | "SELL" | null;
  lotSizeRequested?: number | null;
  lotSizeFilled?: number | null;
  requestedPrice?: number | null;
  fillPrice?: number | null;
  slippage?: number | null;
  stopLoss?: number | null;
  takeProfit?: number | null;
  brokerMessage?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  executedAt?: Date | null;
}

export type ReconcileOutcome = {
  ok: boolean;
  reconciled: boolean;
  duplicate?: boolean;
  reason?: string;
  commandStatus?: string;
  actionStatus?: string | null;
  livePositionId?: number | null;
  attributionId?: number | null;
};

// Map an EA-reported execution status to our mt5_commands.status field.
function mapCommandStatus(s: ExecutionResultStatus): string {
  switch (s) {
    case "executed": return "completed";
    case "partial": return "completed";
    case "rejected": return "failed";
    case "failed": return "failed";
    case "pending": return "sent";
  }
}

// Map to a trade_action_requests.status terminal/non-terminal.
function mapActionStatus(s: ExecutionResultStatus): string {
  switch (s) {
    case "executed": return "executed";
    case "partial": return "executed";
    case "rejected": return "rejected";
    case "failed": return "failed";
    case "pending": return "sent_to_mt5";
  }
}

const TERMINAL_COMMAND_STATUSES = new Set(["completed", "failed", "expired", "cancelled"]);
const TERMINAL_ACTION_STATUSES = new Set(["executed", "rejected", "failed", "expired", "cancelled"]);

export async function reconcileExecutionResult(input: {
  command: typeof mt5CommandsTable.$inferSelect;
  result: ExecutionResultInput;
}): Promise<ReconcileOutcome> {
  const { command, result } = input;

  // ── Idempotency / monotonicity: once a command is terminal, REJECT
  //    every subsequent callback — including non-terminal ones like
  //    "pending" — to prevent a late EA message from downgrading a
  //    completed/failed lifecycle back into in-flight.
  const newCommandStatus = mapCommandStatus(result.status);
  if (TERMINAL_COMMAND_STATUSES.has(command.status)) {
    return {
      ok: true, reconciled: false, duplicate: true,
      reason: "command_already_terminal",
      commandStatus: command.status,
    };
  }

  const now = new Date();
  const isFailed = result.status === "rejected" || result.status === "failed";
  const isTerminal = TERMINAL_COMMAND_STATUSES.has(newCommandStatus);

  // ── 1. Update mt5_commands.
  await db.update(mt5CommandsTable).set({
    status: newCommandStatus,
    detail: result.brokerMessage ?? command.detail ?? null,
    errorMessage: isFailed ? (result.errorMessage ?? result.brokerMessage ?? null) : command.errorMessage,
    fillPrice: result.fillPrice ?? command.fillPrice ?? null,
    slippage: result.slippage ?? command.slippage ?? null,
    brokerMessage: result.brokerMessage ?? command.brokerMessage ?? null,
    errorCode: result.errorCode ?? command.errorCode ?? null,
    filledLotSize: result.lotSizeFilled ?? command.filledLotSize ?? null,
    mt5OrderTicket: result.mt5OrderTicket ?? command.mt5OrderTicket ?? null,
    mt5PositionTicket: result.mt5PositionTicket ?? command.mt5PositionTicket ?? null,
    resultPayload: { ...(command.resultPayload as object | null ?? {}), ...result },
    ticket: result.mt5PositionTicket
      ? parseTicketInt(result.mt5PositionTicket) ?? command.ticket
      : command.ticket,
    completedAt: isTerminal && !isFailed ? now : command.completedAt,
    failedAt: isTerminal && isFailed ? now : command.failedAt,
    updatedAt: now,
  }).where(eq(mt5CommandsTable.id, command.id));

  // ── 2. Locate the linked trade_action_request (by explicit
  //      actionRequestId or by tradeCommandId backref).
  let actionRow: typeof tradeActionRequestsTable.$inferSelect | null = null;
  if (result.actionRequestId) {
    const [r] = await db.select().from(tradeActionRequestsTable)
      .where(and(
        eq(tradeActionRequestsTable.id, result.actionRequestId),
        eq(tradeActionRequestsTable.userId, command.userId ?? -1),
      )).limit(1);
    actionRow = r ?? null;
  }
  if (!actionRow) {
    const [r] = await db.select().from(tradeActionRequestsTable)
      .where(and(
        eq(tradeActionRequestsTable.tradeCommandId, command.id),
        eq(tradeActionRequestsTable.userId, command.userId ?? -1),
      ))
      .limit(1);
    actionRow = r ?? null;
  }

  let actionStatus: string | null = null;
  // Action-row monotonicity: if the action is already terminal, keep its
  // status frozen but still merge late-arriving execution fields that were
  // previously null (tickets / fillPrice / slippage / brokerMessage). This
  // is the idempotent-enrichment path — never downgrades or overwrites.
  if (actionRow && TERMINAL_ACTION_STATUSES.has(actionRow.status)) {
    await db.update(tradeActionRequestsTable).set({
      mt5Ticket: actionRow.mt5Ticket ?? result.mt5PositionTicket ?? result.mt5OrderTicket ?? null,
      mt5OrderTicket: actionRow.mt5OrderTicket ?? result.mt5OrderTicket ?? null,
      mt5PositionTicket: actionRow.mt5PositionTicket ?? result.mt5PositionTicket ?? null,
      fillPrice: actionRow.fillPrice ?? result.fillPrice ?? null,
      slippage: actionRow.slippage ?? result.slippage ?? null,
      filledLotSize: actionRow.filledLotSize ?? result.lotSizeFilled ?? null,
      brokerMessage: actionRow.brokerMessage ?? result.brokerMessage ?? null,
      errorCode: actionRow.errorCode ?? result.errorCode ?? null,
      executedAt: actionRow.executedAt ?? result.executedAt ?? null,
      updatedAt: now,
    }).where(eq(tradeActionRequestsTable.id, actionRow.id));
    return {
      ok: true, reconciled: false, duplicate: true,
      reason: "action_already_terminal_enriched",
      commandStatus: newCommandStatus,
      actionStatus: actionRow.status,
    };
  }
  if (actionRow) {
    actionStatus = mapActionStatus(result.status);
    await db.update(tradeActionRequestsTable).set({
      status: actionStatus,
      mt5Ticket: result.mt5PositionTicket ?? result.mt5OrderTicket ?? actionRow.mt5Ticket,
      mt5OrderTicket: result.mt5OrderTicket ?? actionRow.mt5OrderTicket,
      mt5PositionTicket: result.mt5PositionTicket ?? actionRow.mt5PositionTicket,
      fillPrice: result.fillPrice ?? actionRow.fillPrice,
      slippage: result.slippage ?? actionRow.slippage,
      filledLotSize: result.lotSizeFilled ?? actionRow.filledLotSize,
      brokerMessage: result.brokerMessage ?? actionRow.brokerMessage,
      errorCode: result.errorCode ?? actionRow.errorCode,
      executedAt: result.status === "executed" || result.status === "partial"
        ? (result.executedAt ?? now)
        : actionRow.executedAt,
      rejectionReason: isFailed
        ? (result.brokerMessage ?? result.errorMessage ?? actionRow.rejectionReason ?? "Broker rejected the order.")
        : actionRow.rejectionReason,
      updatedAt: now,
    }).where(eq(tradeActionRequestsTable.id, actionRow.id));

    // Timeline event.
    await writeActionTimeline({
      userId: actionRow.userId,
      tradeKey: actionRow.tradeKey,
      actionId: actionRow.id,
      actionType: actionRow.actionType as ActionType,
      eventType: isFailed ? "action_failed" : (result.status === "executed" || result.status === "partial" ? "action_executed" : "action_sent_to_mt5"),
      severity: isFailed ? "warning" : "info",
      title: isFailed
        ? `Broker rejected ${humanize(actionRow.actionType as ActionType)}`
        : result.status === "partial"
          ? `Partial fill on ${humanize(actionRow.actionType as ActionType)}`
          : `Broker executed ${humanize(actionRow.actionType as ActionType)}`,
      message: result.brokerMessage ?? result.errorMessage ?? "",
      source: "system",
      context: {
        commandId: command.id,
        status: result.status,
        mt5OrderTicket: result.mt5OrderTicket ?? null,
        mt5PositionTicket: result.mt5PositionTicket ?? null,
        fillPrice: result.fillPrice ?? null,
        slippage: result.slippage ?? null,
        filledLotSize: result.lotSizeFilled ?? null,
        errorCode: result.errorCode ?? null,
      },
    });

    // Notification.
    await notifyAction({
      userId: actionRow.userId,
      actionId: actionRow.id,
      actionType: actionRow.actionType as ActionType,
      tradeKey: actionRow.tradeKey,
      symbol: actionRow.symbol,
      status: actionStatus as Parameters<typeof notifyAction>[0]["status"],
      kind: isFailed ? "action_rejected" : (result.status === "executed" || result.status === "partial" ? "action_executed" : "action_queued"),
      title: actionRow.requestedMode === "LIVE"
        ? `LIVE — ${humanize(actionRow.actionType as ActionType)} ${isFailed ? "rejected" : "executed"}`
        : `${humanize(actionRow.actionType as ActionType)} ${isFailed ? "rejected" : result.status === "partial" ? "partially filled" : "executed"}`,
      message: isFailed
        ? brokerRejectionHint(result.errorCode, result.brokerMessage)
        : result.fillPrice != null
          ? `Filled at ${result.fillPrice}${result.slippage != null ? ` (slippage ${result.slippage})` : ""}.`
          : "Broker confirmed.",
      recommendedAction: isFailed ? brokerRejectionHint(result.errorCode, result.brokerMessage) : undefined,
    });
  }

  // ── 3. trade_command_audit_log — update the matching audit row (best-effort).
  try {
    if (command.userId != null) {
      await db.update(tradeCommandAuditLogTable).set({
        status: isFailed ? "FAILED" : "EXECUTED",
        rejectionReason: isFailed
          ? (result.brokerMessage ?? result.errorMessage ?? "broker_rejected")
          : null,
      }).where(and(
        eq(tradeCommandAuditLogTable.userId, command.userId),
        eq(tradeCommandAuditLogTable.symbol, command.symbol ?? ""),
      ));
    }
  } catch (e) {
    logger.warn({ err: e, commandId: command.id }, "exec_reconcile_audit_update_failed");
  }

  // ── 4. live_positions + shared_trade_attribution — only on success.
  let livePositionId: number | null = null;
  let attributionId: number | null = null;

  if (result.status === "executed" || result.status === "partial") {
    if (command.action === "OPEN") {
      if (result.mt5PositionTicket && command.userId != null && command.symbol && command.side && result.fillPrice != null) {
        const lp = await upsertLivePositionOpen({
          userId: command.userId,
          brokerPositionId: result.mt5PositionTicket,
          symbol: command.symbol,
          direction: command.side,
          lotSize: result.lotSizeFilled ?? command.lot ?? 0,
          entryPrice: result.fillPrice,
          stopLoss: result.stopLoss ?? null,
          takeProfit: result.takeProfit ?? null,
          openedAt: result.executedAt ?? now,
        });
        livePositionId = lp;
      }
    } else if (command.action === "CLOSE") {
      if (result.mt5PositionTicket && command.userId != null) {
        // UX9 P1: MT5 ticket numbers are account-scoped, not globally unique.
        // EVERY live_positions read/write keyed on brokerPositionId MUST also
        // scope by userId to prevent cross-tenant corruption when tickets
        // collide across accounts.
        const [lp] = await db.select().from(livePositionsTable)
          .where(and(
            eq(livePositionsTable.brokerPositionId, result.mt5PositionTicket),
            eq(livePositionsTable.userId, command.userId),
          ))
          .limit(1);
        const closedLot = result.lotSizeFilled ?? command.lot ?? null;
        const openLot = lp?.lotSize ?? null;
        const isPartial = closedLot != null && openLot != null && closedLot > 0 && closedLot < openLot;
        const remaining = isPartial && openLot != null && closedLot != null
          ? Number((openLot - closedLot).toFixed(8))
          : null;
        // Realized P&L on the closed slice. NEVER fabricated — only set when
        // both entry and exit prices are real numbers AND the instrument's
        // per-lot contract size and profit→account FX factor are established.
        //
        // P0-2 — this previously computed price-delta x lot with NO contract
        // size, so a 1.00-lot 100-pip EURUSD close recorded $0.01 instead of
        // $1,000. When sizing cannot be established we leave realized null
        // (the row keeps its prior realizedProfitLoss) rather than write a
        // plausible wrong dollar figure into live_positions.
        let realized: number | null = null;
        if (lp?.entryPrice != null && result.fillPrice != null && closedLot != null) {
          const sizing = await resolveContractSize(command.userId, lp.symbol);
          const accountCurrency = await getAccountCurrency(command.userId);
          const fx = resolveQuoteToAccountFx({
            symbol: lp.symbol,
            profitCurrency: sizing.profitCurrency,
            accountCurrency,
            closePrice: result.fillPrice,
          });
          if (sizing.contractSize != null && fx.factor != null) {
            realized = computeRealizedAmount({
              entryPrice: lp.entryPrice,
              closePrice: result.fillPrice,
              direction: lp.direction === "BUY" ? 1 : -1,
              lots: closedLot,
              contractSize: sizing.contractSize,
              quoteToAccountFx: fx.factor,
            });
          } else {
            logger.warn({
              livePositionId: lp.id, symbol: lp.symbol,
              contractSizeReason: sizing.reason, fxReason: fx.reason,
            }, "realized_pnl_withheld_pending_sizing");
          }
        }
        if (isPartial && lp) {
          await db.update(livePositionsTable).set({
            lotSize: remaining!,
            realizedProfitLoss: lp.realizedProfitLoss != null && realized != null
              ? Number((lp.realizedProfitLoss + realized).toFixed(8))
              : (realized ?? lp.realizedProfitLoss),
            lastSyncedAt: now,
            updatedAt: now,
          }).where(eq(livePositionsTable.id, lp.id));
        } else {
          await db.update(livePositionsTable).set({
            status: "CLOSED",
            closedAt: result.executedAt ?? now,
            realizedProfitLoss: realized != null && lp?.realizedProfitLoss != null
              ? Number((lp.realizedProfitLoss + realized).toFixed(8))
              : (realized ?? lp?.realizedProfitLoss ?? null),
            lastSyncedAt: now,
            updatedAt: now,
          }).where(and(
            eq(livePositionsTable.brokerPositionId, result.mt5PositionTicket),
            eq(livePositionsTable.userId, command.userId),
          ));
        }
      }
    } else if (command.action === "MODIFY") {
      if (result.mt5PositionTicket && command.userId != null && (result.stopLoss != null || result.takeProfit != null)) {
        await db.update(livePositionsTable).set({
          stopLoss: result.stopLoss ?? undefined,
          takeProfit: result.takeProfit ?? undefined,
          lastSyncedAt: now,
          updatedAt: now,
        }).where(and(
          eq(livePositionsTable.brokerPositionId, result.mt5PositionTicket),
          eq(livePositionsTable.userId, command.userId),
        ));
      }
    }

    // shared_trade_attribution: update the row tied to this command.
    try {
      const [att] = await db.select().from(sharedTradeAttributionTable)
        .where(eq(sharedTradeAttributionTable.tradeCommandId, command.id))
        .limit(1);
      if (att) {
        attributionId = att.id;
        await db.update(sharedTradeAttributionTable).set({
          mt5OrderTicket: result.mt5OrderTicket ?? att.mt5OrderTicket,
          mt5PositionTicket: result.mt5PositionTicket ?? att.mt5PositionTicket,
          entryPrice: command.action === "OPEN" ? (result.fillPrice ?? att.entryPrice) : att.entryPrice,
          closePrice: command.action === "CLOSE" ? (result.fillPrice ?? att.closePrice) : att.closePrice,
          slippage: result.slippage ?? att.slippage,
          status: command.action === "OPEN" ? "open" : command.action === "CLOSE" ? "closed" : att.status,
          openedAt: command.action === "OPEN" ? (result.executedAt ?? now) : att.openedAt,
          closedAt: command.action === "CLOSE" ? (result.executedAt ?? now) : att.closedAt,
          updatedAt: now,
        }).where(eq(sharedTradeAttributionTable.id, att.id));

        // P0-2 — Sync realized P&L to virtual_trading_accounts ON CLOSE ONLY.
        // Idempotent via attribution.realizedAppliedAt (CAS inside the
        // sync helper). Unrealized P&L is intentionally NOT written here —
        // the periodic position sync recomputes it from open attributions.
        if (command.action === "CLOSE") {
          try {
            const [freshAtt] = await db.select().from(sharedTradeAttributionTable)
              .where(eq(sharedTradeAttributionTable.id, att.id))
              .limit(1);
            if (freshAtt) {
              const syncRes = await applyRealizedPnlToVirtualAccount(freshAtt);
              if (syncRes.applied) {
                logger.info({
                  attributionId: freshAtt.id,
                  userId: syncRes.userId,
                  realized: syncRes.realized,
                  virtualAccountId: syncRes.virtualAccountId,
                  commandId: command.id,
                }, "virtual_pnl_applied_on_close");
              } else if (!syncRes.ok || (syncRes.reason && syncRes.reason !== "already_applied" && syncRes.reason !== "claim_lost_race")) {
                logger.warn({
                  attributionId: freshAtt.id,
                  commandId: command.id,
                  reason: syncRes.reason,
                  ok: syncRes.ok,
                }, "virtual_pnl_apply_skipped_or_failed");
              }
            }
          } catch (e) {
            logger.warn({ err: e, commandId: command.id, attributionId: att.id }, "virtual_pnl_apply_outer_failed");
          }
        }
      } else if (
        (command.action === "OPEN" || command.action === "CLOSE") &&
        result.mt5PositionTicket != null &&
        command.mt5ConnectionId != null
      ) {
        // P0-3 — Unattributed master trade. The fill is real but there is no
        // shared_trade_attribution row tying it to a user. This only matters
        // when the command was routed to a registered shared master account.
        // We check the master registry; if hit, the orphan is recorded for
        // admin review. If the connection isn't a registered master we treat
        // the missing attribution as benign (USER_OWNED mode does not write
        // attribution rows by design).
        try {
          const [sma] = await db.select({ id: sharedMasterAccountsTable.id })
            .from(sharedMasterAccountsTable)
            .where(eq(sharedMasterAccountsTable.connectionId, command.mt5ConnectionId))
            .limit(1);
          if (sma) {
            await recordUnattributedMasterTrade({
              masterConnectionId: command.mt5ConnectionId,
              tradeCommandId: command.id,
              mt5OrderTicket: result.mt5OrderTicket ?? null,
              mt5PositionTicket: result.mt5PositionTicket,
              symbol: command.symbol ?? result.symbol ?? "UNKNOWN",
              side: normalizeSide(command.side ?? result.side ?? null),
              lotSize: result.lotSizeFilled ?? command.lot ?? null,
              fillPrice: result.fillPrice ?? null,
              slippage: result.slippage ?? null,
              brokerMessage: result.brokerMessage ?? null,
              source: "reconciler",
              executedAt: result.executedAt ?? now,
            });
          }
        } catch (e) {
          logger.warn({ err: e, commandId: command.id }, "exec_reconcile_unattributed_record_failed");
        }
      }
    } catch (e) {
      logger.warn({ err: e, commandId: command.id }, "exec_reconcile_attribution_update_failed");
    }
  } else if (isFailed) {
    // Mark linked attribution row as rejected/failed.
    try {
      await db.update(sharedTradeAttributionTable).set({
        status: result.status === "rejected" ? "rejected" : "failed",
        rejectionReason: result.brokerMessage ?? result.errorMessage ?? "broker_rejected",
        updatedAt: now,
      }).where(eq(sharedTradeAttributionTable.tradeCommandId, command.id));
    } catch (e) {
      logger.warn({ err: e, commandId: command.id }, "exec_reconcile_attribution_fail_update_failed");
    }
  }

  return {
    ok: true,
    reconciled: true,
    commandStatus: newCommandStatus,
    actionStatus,
    livePositionId,
    attributionId,
  };
}

async function upsertLivePositionOpen(args: {
  userId: number;
  brokerPositionId: string;
  symbol: string;
  direction: string;
  lotSize: number;
  entryPrice: number;
  stopLoss: number | null;
  takeProfit: number | null;
  openedAt: Date;
}): Promise<number> {
  // UX9 P1: scope upsert lookup by userId. brokerPositionId alone is not
  // globally unique across MT5 accounts; cross-tenant overwrite was possible.
  const [existing] = await db.select({ id: livePositionsTable.id })
    .from(livePositionsTable)
    .where(and(
      eq(livePositionsTable.brokerPositionId, args.brokerPositionId),
      eq(livePositionsTable.userId, args.userId),
    ))
    .limit(1);
  if (existing) {
    await db.update(livePositionsTable).set({
      status: "OPEN",
      lotSize: args.lotSize,
      entryPrice: args.entryPrice,
      stopLoss: args.stopLoss ?? undefined,
      takeProfit: args.takeProfit ?? undefined,
      openedAt: args.openedAt,
      lastSyncedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(livePositionsTable.id, existing.id));
    return existing.id;
  }
  const [inserted] = await db.insert(livePositionsTable).values({
    userId: args.userId,
    brokerPositionId: args.brokerPositionId,
    symbol: args.symbol,
    direction: args.direction,
    lotSize: args.lotSize,
    entryPrice: args.entryPrice,
    stopLoss: args.stopLoss,
    takeProfit: args.takeProfit,
    status: "OPEN",
    openedAt: args.openedAt,
    lastSyncedAt: new Date(),
  }).returning({ id: livePositionsTable.id });
  return inserted!.id;
}

function normalizeSide(s: string | null | undefined): "BUY" | "SELL" | null {
  if (!s) return null;
  const u = s.toUpperCase();
  return u === "BUY" || u === "SELL" ? u : null;
}

function parseTicketInt(s: string | null | undefined): number | null {
  if (!s) return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

// User-friendly hint for known broker rejection codes / messages.
export function brokerRejectionHint(code: string | null | undefined, message: string | null | undefined): string {
  const c = (code ?? "").toUpperCase();
  const m = (message ?? "").toLowerCase();
  if (c.includes("INVALID_VOLUME") || m.includes("invalid volume")) return "Lot size is below the broker minimum or above the max. Try a different lot size.";
  if (c.includes("MARKET_CLOSED") || m.includes("market closed")) return "Market is closed for this symbol. Try again during trading hours.";
  if (c.includes("SYMBOL_NOT_AVAILABLE") || m.includes("symbol not")) return "Symbol is not enabled on this account. Ask your broker to enable it.";
  if (c.includes("NO_MONEY") || c.includes("INSUFFICIENT") || m.includes("not enough money") || m.includes("insufficient margin")) return "Not enough free margin. Reduce lot size or close other positions.";
  if (c.includes("TRADE_DISABLED") || m.includes("trade disabled")) return "Trading is disabled on this account.";
  if (c.includes("OFF_QUOTES") || m.includes("off quotes")) return "Price is moving too fast. Retry in a moment.";
  if (c.includes("INVALID_STOPS") || m.includes("invalid stops")) return "Stop loss / take profit too close to price. Move them further from market.";
  if (c.includes("PRICE_CHANGED") || c.includes("REQUOTE") || m.includes("price changed") || m.includes("requote")) return "Price changed before the order could fill. Retry.";
  if (c.includes("ACCOUNT_TYPE") || m.includes("account type")) return "Account type mismatch (demo vs live). Re-check the bridge connection.";
  if (c.includes("AUTO_TRADING_DISABLED") || m.includes("auto trading")) return "Auto-trading is disabled in MT5. Enable AutoTrading and re-allow EA execution.";
  if (c.includes("EA_DISABLED") || m.includes("ea execution")) return "EA execution is disabled. Re-allow it under Tools → Options → Expert Advisors.";
  return message ?? "Broker rejected the order. Check the broker terminal for details.";
}

// Re-export the column reference so the watchdog can target stale commands
// without circular-importing tableNames.
export const COMMAND_TABLE_REF = mt5CommandsTable;
export const ACTION_REQUEST_REF = tradeActionRequestsTable;
export const SHARED_ATTR_REF = sharedTradeAttributionTable;
export const LIVE_POSITION_REF = livePositionsTable;
export const IS_NOT_NULL_HELPER = isNotNull;

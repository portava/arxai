// P0-3 — Unattributed master trade recorder.
//
// SAFETY:
//   * NEVER opens, closes, or modifies any trade. Pure ledger insert + admin
//     notification.
//   * Idempotent on (tradeCommandId, mt5PositionTicket): repeat callbacks for
//     the same master fill produce one row, not many.
//   * No secrets read or written. masterConnectionId is an internal FK only.
//   * Admin notification is a system-wide alert (notifications.userId=NULL)
//     so admins see it in their existing alert center without leaking any
//     user-specific context.

import { db } from "@workspace/db";
import {
  unattributedMasterTradesTable,
  notificationsTable,
  sharedMasterAccountsTable,
  type UnattributedMasterTradeRow,
} from "@workspace/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { logger } from "../logger.js";

export interface RecordUnattributedMasterTradeInput {
  masterConnectionId: number;
  tradeCommandId?: number | null;
  mt5OrderTicket?: string | null;
  mt5PositionTicket?: string | null;
  symbol: string;
  side?: "BUY" | "SELL" | null;
  lotSize?: number | null;
  fillPrice?: number | null;
  slippage?: number | null;
  brokerMessage?: string | null;
  source?: "reconciler" | "sync_positions" | "manual";
  executedAt?: Date | null;
}

export interface RecordUnattributedResult {
  ok: boolean;
  recorded: boolean;
  duplicate?: boolean;
  rowId?: number;
  reason?: string;
}

/**
 * Insert an unattributed master trade and fire a HIGH-severity admin
 * notification. Idempotent on (tradeCommandId, mt5PositionTicket).
 *
 * Returns { recorded: false, duplicate: true } when an identical row already
 * exists — never throws on duplicate.
 */
export async function recordUnattributedMasterTrade(
  input: RecordUnattributedMasterTradeInput,
): Promise<RecordUnattributedResult> {
  // Resolve the sharedMasterAccount row from masterConnectionId. NULL when
  // the connection isn't actually registered as a master — still record it,
  // admin can decide what it was.
  let sharedMasterAccountId: number | null = null;
  try {
    const [sma] = await db.select({ id: sharedMasterAccountsTable.id })
      .from(sharedMasterAccountsTable)
      .where(eq(sharedMasterAccountsTable.connectionId, input.masterConnectionId))
      .limit(1);
    sharedMasterAccountId = sma?.id ?? null;
  } catch (e) {
    logger.warn({ err: e }, "unattributed_master_trades_resolve_master_failed");
  }

  // Idempotency. Two dedupe paths depending on caller:
  //   (a) Reconciler path — has tradeCommandId. Dedupe on
  //       (tradeCommandId, mt5PositionTicket): the same master fill cannot
  //       produce a duplicate row even on repeated reconciler invocation.
  //   (b) sync_positions path — has NO tradeCommandId (purely manual master
  //       trade with no ARX command). Dedupe on
  //       (masterConnectionId, mt5PositionTicket) AND tradeCommandId IS NULL
  //       — the EA reports the same open position every sync tick, so
  //       without this guard we would insert one row per tick.
  if (input.mt5PositionTicket) {
    try {
      if (input.tradeCommandId != null) {
        const [existing] = await db.select({ id: unattributedMasterTradesTable.id })
          .from(unattributedMasterTradesTable)
          .where(and(
            eq(unattributedMasterTradesTable.tradeCommandId, input.tradeCommandId),
            eq(unattributedMasterTradesTable.mt5PositionTicket, input.mt5PositionTicket),
          ))
          .limit(1);
        if (existing) {
          return { ok: true, recorded: false, duplicate: true, rowId: existing.id, reason: "already_recorded" };
        }
      } else {
        const [existing] = await db.select({ id: unattributedMasterTradesTable.id })
          .from(unattributedMasterTradesTable)
          .where(and(
            eq(unattributedMasterTradesTable.masterConnectionId, input.masterConnectionId),
            eq(unattributedMasterTradesTable.mt5PositionTicket, input.mt5PositionTicket),
            isNull(unattributedMasterTradesTable.tradeCommandId),
          ))
          .limit(1);
        if (existing) {
          return { ok: true, recorded: false, duplicate: true, rowId: existing.id, reason: "already_recorded_no_command" };
        }
      }
    } catch (e) {
      logger.warn({ err: e }, "unattributed_master_trades_dedupe_check_failed");
    }
  }

  let inserted: UnattributedMasterTradeRow | undefined;
  try {
    const [row] = await db.insert(unattributedMasterTradesTable).values({
      sharedMasterAccountId,
      masterConnectionId: input.masterConnectionId,
      tradeCommandId: input.tradeCommandId ?? null,
      mt5OrderTicket: input.mt5OrderTicket ?? null,
      mt5PositionTicket: input.mt5PositionTicket ?? null,
      symbol: input.symbol,
      side: input.side ?? null,
      lotSize: input.lotSize ?? null,
      fillPrice: input.fillPrice ?? null,
      slippage: input.slippage ?? null,
      brokerMessage: input.brokerMessage ?? null,
      source: input.source ?? "reconciler",
      status: "pending_review",
      executedAt: input.executedAt ?? null,
    }).returning();
    inserted = row;
  } catch (e) {
    logger.error({ err: e, input }, "unattributed_master_trades_insert_failed");
    return { ok: false, recorded: false, reason: "insert_failed" };
  }
  if (!inserted) {
    return { ok: false, recorded: false, reason: "insert_no_row" };
  }

  // Fire admin notification (system-wide, userId=NULL). Dedupe by row id so
  // repeated near-simultaneous inserts don't multi-fire.
  try {
    const dedupe = `unattributed_master_trade:${inserted.id}`;
    const notifId = `unattr-master-${inserted.id}-${Date.now()}`;
    await db.insert(notificationsTable).values({
      userId: null, // system-wide → admins only
      notificationId: notifId,
      type: "BROKER",
      severity: "HIGH",
      status: "UNREAD",
      title: "Unattributed master trade detected",
      message:
        `A fill on the shared master (connection #${input.masterConnectionId}, symbol ${input.symbol}) ` +
        `has no matching user attribution. Review and link or dismiss in the Shared Master admin panel.`,
      sourceBuild: "P0-3",
      sourceEventId: String(inserted.id),
      symbol: input.symbol,
      actionRequired: true,
      recommendedAction: "Open the Shared Master admin panel and link or dismiss the trade.",
      actionUrl: "/admin/shared-master/unattributed",
      metadata: {
        unattributedTradeId: inserted.id,
        masterConnectionId: input.masterConnectionId,
        sharedMasterAccountId,
        mt5OrderTicket: input.mt5OrderTicket ?? null,
        mt5PositionTicket: input.mt5PositionTicket ?? null,
        tradeCommandId: input.tradeCommandId ?? null,
        source: input.source ?? "reconciler",
      },
      dedupeKey: dedupe,
    }).onConflictDoNothing({ target: notificationsTable.dedupeKey });
  } catch (e) {
    logger.warn({ err: e, rowId: inserted.id }, "unattributed_master_trades_notify_failed");
  }

  return { ok: true, recorded: true, rowId: inserted.id };
}

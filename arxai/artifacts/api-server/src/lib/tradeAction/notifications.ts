// Phase UX8 — Trade Action Center notifications.
//
// Writes to the existing `notifications` table. Cooldown is enforced via
// `dedupe_key` uniqueIndex + bucketed timestamps so repeated AI
// suggestions on the same (userId, tradeKey, actionType) within a 5-min
// window are coalesced rather than spammed.

import { db } from "@workspace/db";
import { notificationsTable } from "@workspace/db/schema";
import { logger } from "../logger.js";
import type { ActionType, ActionStatus } from "./types.js";

const COOLDOWN_MS = 5 * 60 * 1000;

function bucket(ts: Date = new Date()): string {
  return String(Math.floor(ts.getTime() / COOLDOWN_MS));
}

export type ActionNotificationKind =
  | "action_suggested"
  | "action_awaiting_confirmation"
  | "action_queued"
  | "action_executed"
  | "action_rejected"
  | "action_failed"
  | "action_expired"
  | "live_confirmation_missing";

const SEVERITY_BY_KIND: Record<ActionNotificationKind, "INFO" | "WARNING" | "HIGH" | "CRITICAL"> = {
  action_suggested: "INFO",
  action_awaiting_confirmation: "WARNING",
  action_queued: "INFO",
  action_executed: "INFO",
  action_rejected: "WARNING",
  action_failed: "HIGH",
  action_expired: "INFO",
  live_confirmation_missing: "HIGH",
};

export async function notifyAction(opts: {
  userId: number;
  actionId: number;
  actionType: ActionType;
  tradeKey: string | null;
  symbol: string;
  status: ActionStatus;
  kind: ActionNotificationKind;
  title: string;
  message: string;
  recommendedAction?: string;
}): Promise<void> {
  const dedupeKey = [
    "tac",
    opts.userId,
    opts.tradeKey ?? "no-trade",
    opts.actionType,
    opts.kind,
    bucket(),
  ].join(":");

  try {
    await db.insert(notificationsTable).values({
      userId: opts.userId,
      notificationId: `tac_${opts.actionId}_${opts.kind}_${Date.now()}`,
      type: "TRADE",
      severity: SEVERITY_BY_KIND[opts.kind],
      title: opts.title,
      message: opts.message,
      sourceBuild: "UX8",
      sourceEventId: String(opts.actionId),
      symbol: opts.symbol,
      relatedTradeId: opts.tradeKey,
      actionRequired: opts.kind === "action_awaiting_confirmation" || opts.kind === "live_confirmation_missing",
      recommendedAction: opts.recommendedAction ?? null,
      actionUrl: `/action-center?focus=${opts.actionId}`,
      metadata: {
        actionId: opts.actionId,
        actionType: opts.actionType,
        status: opts.status,
        kind: opts.kind,
      },
      dedupeKey,
    }).onConflictDoNothing();
  } catch (e) {
    logger.warn({ err: e, actionId: opts.actionId, kind: opts.kind }, "action_notify_failed");
  }
}

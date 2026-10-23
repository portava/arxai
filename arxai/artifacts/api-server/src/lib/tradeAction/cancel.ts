// Phase UX8 — Trade Action Center: cancel.
//
// Users can cancel any non-terminal action that has NOT yet reached
// queued (once queued, the command is in the MT5 pipeline and is the
// EA's responsibility to ignore/cancel).

import { db } from "@workspace/db";
import { tradeActionRequestsTable } from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";
import { writeActionTimeline } from "./timeline.js";
import { canTransition } from "./statusMachine.js";
import { toSummary } from "./create.js";
import type { ActionStatus, ActionSummary, ActionType } from "./types.js";

export type CancelResult =
  | { ok: true; action: ActionSummary }
  | { ok: false; error: string };

export async function cancelAction(opts: { userId: number; actionId: number; reason?: string }): Promise<CancelResult> {
  const [row] = await db.select().from(tradeActionRequestsTable)
    .where(and(eq(tradeActionRequestsTable.id, opts.actionId), eq(tradeActionRequestsTable.userId, opts.userId)))
    .limit(1);
  if (!row) return { ok: false, error: "action_not_found" };

  const status = row.status as ActionStatus;
  if (!canTransition(status, "cancelled")) {
    return { ok: false, error: `cannot_cancel_from_status:${status}` };
  }

  await db.update(tradeActionRequestsTable).set({
    status: "cancelled",
    rejectionReason: opts.reason ?? "Cancelled by user.",
    updatedAt: new Date(),
  }).where(eq(tradeActionRequestsTable.id, row.id));

  await writeActionTimeline({
    userId: row.userId, tradeKey: row.tradeKey, actionId: row.id,
    actionType: row.actionType as ActionType,
    eventType: "action_cancelled",
    severity: "info",
    title: "Action cancelled",
    message: opts.reason ?? "",
    source: "user",
  });

  const [updated] = await db.select().from(tradeActionRequestsTable).where(eq(tradeActionRequestsTable.id, row.id)).limit(1);
  return { ok: true, action: toSummary(updated!) };
}

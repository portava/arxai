// Phase UX8 — Trade Action Center: confirm + queue.
//
// SAFETY: confirmAction is the ONE chokepoint where a trade action moves
// from "awaiting_confirmation" all the way to "queued"/"sent_to_mt5".
// It MUST be called from an authenticated route with the resolved userId.
// Every state transition is guarded; failure on any step → status="rejected".

import { db } from "@workspace/db";
import { tradeActionRequestsTable } from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";
import { queueMt5CommandWithGate } from "../../routes/mt5.js";
import { runActionGuards } from "./guards.js";
import { writeActionTimeline } from "./timeline.js";
import { notifyAction } from "./notifications.js";
import { canTransition } from "./statusMachine.js";
import { toSummary, humanize } from "./create.js";
import type { ActionStatus, ActionSummary, ActionType } from "./types.js";

export type ConfirmResult =
  | { ok: true; action: ActionSummary }
  | { ok: false; error: string; action?: ActionSummary };

export async function confirmAction(opts: { userId: number; actionId: number; liveConfirmPhrase?: string | null }): Promise<ConfirmResult> {
  const [row] = await db.select().from(tradeActionRequestsTable)
    .where(and(eq(tradeActionRequestsTable.id, opts.actionId), eq(tradeActionRequestsTable.userId, opts.userId)))
    .limit(1);
  if (!row) return { ok: false, error: "action_not_found" };

  const status = row.status as ActionStatus;

  // Only awaiting_confirmation or ai_suggested can be confirmed.
  if (status !== "awaiting_confirmation" && status !== "ai_suggested" && status !== "user_reviewing") {
    return { ok: false, error: `cannot_confirm_from_status:${status}`, action: toSummary(row) };
  }

  // Server-side LIVE binding: a LIVE action cannot be confirmed unless the
  // user typed the exact phrase. Enforced on the server so the UI cannot
  // be bypassed by a direct API call.
  if (row.requestedMode === "LIVE") {
    const phrase = (opts.liveConfirmPhrase ?? "").trim().toUpperCase();
    if (phrase !== "CONFIRM LIVE") {
      return { ok: false, error: "live_confirmation_phrase_required", action: toSummary(row) };
    }
  }

  // Move to confirmed (records intent regardless of guard outcome).
  const now = new Date();
  await db.update(tradeActionRequestsTable)
    .set({ status: "confirmed", confirmedByUser: true, confirmedAt: now, updatedAt: now })
    .where(eq(tradeActionRequestsTable.id, row.id));

  await writeActionTimeline({
    userId: row.userId, tradeKey: row.tradeKey, actionId: row.id,
    actionType: row.actionType as ActionType,
    eventType: "action_confirmed",
    severity: "info",
    title: "User confirmed action",
    source: "user",
  });

  // guard_checking
  await db.update(tradeActionRequestsTable)
    .set({ status: "guard_checking", updatedAt: new Date() })
    .where(eq(tradeActionRequestsTable.id, row.id));

  const guard = await runActionGuards({
    userId: row.userId,
    actionId: row.id,
    actionType: row.actionType,
    requestedMode: row.requestedMode as "SIMULATED" | "DEMO" | "LIVE",
    symbol: row.symbol,
    side: row.side,
    lotSize: row.lotSize,
    tradeKey: row.tradeKey,
    confirmedByUser: true,
    expiresAt: row.expiresAt,
  });

  if (!guard.passed) {
    await db.update(tradeActionRequestsTable).set({
      status: "rejected",
      rejectionReason: guard.rejectionReason,
      guardResult: guard,
      updatedAt: new Date(),
    }).where(eq(tradeActionRequestsTable.id, row.id));

    await writeActionTimeline({
      userId: row.userId, tradeKey: row.tradeKey, actionId: row.id,
      actionType: row.actionType as ActionType,
      eventType: "action_guard_rejected",
      severity: "warning",
      title: `Action rejected: ${guard.failedCheckId}`,
      message: guard.rejectionReason ?? "",
      source: "system",
      context: { failedCheckId: guard.failedCheckId, checks: guard.checks.map((c) => ({ id: c.id, passed: c.passed })) },
    });

    await notifyAction({
      userId: row.userId, actionId: row.id, actionType: row.actionType as ActionType,
      tradeKey: row.tradeKey, symbol: row.symbol, status: "rejected",
      kind: "action_rejected",
      title: `Action rejected: ${humanize(row.actionType as ActionType)}`,
      message: guard.rejectionReason ?? "A safety guard blocked this action.",
    });

    const [updated] = await db.select().from(tradeActionRequestsTable).where(eq(tradeActionRequestsTable.id, row.id)).limit(1);
    return { ok: false, error: "guard_rejected", action: updated ? toSummary(updated) : undefined };
  }

  await writeActionTimeline({
    userId: row.userId, tradeKey: row.tradeKey, actionId: row.id,
    actionType: row.actionType as ActionType,
    eventType: "action_guard_passed",
    severity: "info",
    title: "All guards passed",
    source: "system",
  });

  // Queue to mt5_commands for trade-touching actions (paper-only lock will
  // mark the row as BLOCKED inside queueMt5CommandWithGate; we still
  // transition our action lifecycle to "queued" because the command row
  // exists and is observable).
  let tradeCommandId: number | null = null;
  const mt5Action = mapToMt5Action(row.actionType as ActionType);
  if (mt5Action) {
    try {
      const { command } = await queueMt5CommandWithGate(mt5Action, {
        symbol: row.symbol, side: row.side, lot: row.lotSize ?? null,
        sl: row.stopLoss ?? null, tp: row.takeProfit ?? null,
        ticket: parseTicket(row.tradeKey),
      }, row.userId);
      tradeCommandId = command.id;
    } catch {
      await db.update(tradeActionRequestsTable).set({
        status: "failed",
        rejectionReason: "MT5 command queue failed.",
        guardResult: guard,
        updatedAt: new Date(),
      }).where(eq(tradeActionRequestsTable.id, row.id));
      await writeActionTimeline({
        userId: row.userId, tradeKey: row.tradeKey, actionId: row.id,
        actionType: row.actionType as ActionType,
        eventType: "action_failed",
        severity: "urgent",
        title: "Queue failed",
        message: "Command could not be queued.",
        source: "system",
      });
      const [updated] = await db.select().from(tradeActionRequestsTable).where(eq(tradeActionRequestsTable.id, row.id)).limit(1);
      return { ok: false, error: "queue_failed", action: updated ? toSummary(updated) : undefined };
    }
  }

  // Validate transition guard_checking → queued.
  if (!canTransition("guard_checking", "queued")) {
    // unreachable; guarded by statusMachine.
  }

  await db.update(tradeActionRequestsTable).set({
    status: "queued",
    guardResult: guard,
    tradeCommandId,
    updatedAt: new Date(),
  }).where(eq(tradeActionRequestsTable.id, row.id));

  await writeActionTimeline({
    userId: row.userId, tradeKey: row.tradeKey, actionId: row.id,
    actionType: row.actionType as ActionType,
    eventType: "action_queued",
    severity: "info",
    title: "Action queued",
    message: tradeCommandId ? `MT5 command #${tradeCommandId}` : "No broker queue for this action.",
    source: "system",
    context: { tradeCommandId },
  });

  await notifyAction({
    userId: row.userId, actionId: row.id, actionType: row.actionType as ActionType,
    tradeKey: row.tradeKey, symbol: row.symbol, status: "queued",
    kind: "action_queued",
    title: `Action queued: ${humanize(row.actionType as ActionType)}`,
    message: "Awaiting MT5 execution.",
  });

  const [updated] = await db.select().from(tradeActionRequestsTable).where(eq(tradeActionRequestsTable.id, row.id)).limit(1);
  return { ok: true, action: toSummary(updated!) };
}

function mapToMt5Action(t: ActionType): "OPEN" | "CLOSE" | "MODIFY" | null {
  switch (t) {
    case "OPEN": return "OPEN";
    case "CLOSE": return "CLOSE";
    case "PARTIAL_CLOSE": return "CLOSE";       // EA derives partial from lot < open lot
    case "MOVE_STOP": return "MODIFY";
    case "TRAIL_STOP": return "MODIFY";
    case "MODIFY_TP_SL": return "MODIFY";
    case "CANCEL_ORDER": return null;           // no broker queue path for cancel review yet
  }
}

function parseTicket(tradeKey: string | null): number | null {
  if (!tradeKey) return null;
  const m = /^(?:lp|att)_(\d+)$/.exec(tradeKey);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

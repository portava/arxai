// Phase UX8 — Trade Action Center: confirm + queue.
//
// SAFETY: confirmAction is the ONE chokepoint where a trade action moves
// from "awaiting_confirmation" all the way to "queued"/"sent_to_mt5".
// It MUST be called from an authenticated route with the resolved userId.
// Every state transition is guarded; failure on any step → status="rejected".

import { db } from "@workspace/db";
import { tradeActionRequestsTable } from "@workspace/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { routeConfirmedAction, type RouteResult } from "./route.js";
import { runActionGuards } from "./guards.js";
import { writeActionTimeline } from "./timeline.js";
import { notifyAction } from "./notifications.js";
import { canTransition } from "./statusMachine.js";
import { toSummary, humanize } from "./create.js";
import type { ActionStatus, ActionSummary, ActionType } from "./types.js";
import type { SimulatedOpenReceipt } from "../tradeEngine/simulatedOpen.js";

export type ConfirmResult =
  | { ok: true; action: ActionSummary; /** SIMULATED open: the PAPER order it booked (owner decision 13). */ paper?: SimulatedOpenReceipt }
  | { ok: false; error: string; action?: ActionSummary };

const CONFIRMABLE: ActionStatus[] = ["awaiting_confirmation", "ai_suggested", "user_reviewing"];

type ActionRow = typeof tradeActionRequestsTable.$inferSelect;
const routable = (row: ActionRow, sourcePage?: string) => ({
  userId: row.userId, actionType: row.actionType as ActionType, requestedMode: row.requestedMode,
  tradeKey: row.tradeKey, symbol: row.symbol, side: row.side, orderType: row.orderType ?? null,
  lotSize: row.lotSize ?? null, requestedPrice: row.requestedPrice ?? null,
  stopLoss: row.stopLoss ?? null, takeProfit: row.takeProfit ?? null, source: row.source ?? null,
  actionId: row.id,
  ...(sourcePage ? { sourcePage } : {}),
  origin: (row.source === "ai_suggested" ? "ruby" : row.source === "decision_engine" ? "automation" : "manual") as "manual" | "ruby" | "automation",
});
const isSimulatedOpen = (row: ActionRow) => row.requestedMode === "SIMULATED" && row.actionType === "OPEN";

export async function confirmAction(opts: {
  userId: number; actionId: number; liveConfirmPhrase?: string | null;
  /** The mode the trader saw and confirmed; a SIMULATED open requires "SIMULATED" (owner decision 13). */
  confirmedMode?: string | null;
  /** The surface stamped on the venue command when it is not the Trade Action Center (My Trades: owner decision 15). */
  sourcePage?: string;
}): Promise<ConfirmResult> {
  const [row] = await db.select().from(tradeActionRequestsTable)
    .where(and(eq(tradeActionRequestsTable.id, opts.actionId), eq(tradeActionRequestsTable.userId, opts.userId)))
    .limit(1);
  if (!row) return { ok: false, error: "action_not_found" };

  const status = row.status as ActionStatus;

  // Only awaiting_confirmation or ai_suggested can be confirmed.
  if (!CONFIRMABLE.includes(status)) {
    // Retry-safe (owner decision 13): a repeated confirm of a SIMULATED open
    // that already booked its paper order returns that order; nothing new.
    if (isSimulatedOpen(row) && row.executionVenue === "PAPER" && row.venueCommandId?.startsWith("paper_order:")) {
      const replay = await routeConfirmedAction(routable(row)).catch(() => null);
      if (replay?.ok && replay.paper) return { ok: true, action: toSummary(row), paper: replay.paper };
    }
    return { ok: false, error: `cannot_confirm_from_status:${status}`, action: toSummary(row) };
  }

  // Explicit simulated-mode labelling (owner decision 13): a SIMULATED open
  // books a paper order, so the confirm must say it is confirming SIMULATED.
  if (isSimulatedOpen(row) && (opts.confirmedMode ?? "").trim().toUpperCase() !== "SIMULATED") {
    return { ok: false, error: "simulated_mode_label_required", action: toSummary(row) };
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

  // Move to confirmed (records intent regardless of guard outcome). The
  // transition is conditional on the row still being confirmable, so two
  // concurrent confirms of one action cannot both proceed.
  const now = new Date();
  const claimed = await db.update(tradeActionRequestsTable)
    .set({ status: "confirmed", confirmedByUser: true, confirmedAt: now, updatedAt: now })
    .where(and(eq(tradeActionRequestsTable.id, row.id), inArray(tradeActionRequestsTable.status, CONFIRMABLE)))
    .returning({ id: tradeActionRequestsTable.id });
  if (!claimed.length) {
    const [cur] = await db.select().from(tradeActionRequestsTable).where(eq(tradeActionRequestsTable.id, row.id)).limit(1);
    return { ok: false, error: `cannot_confirm_from_status:${cur?.status ?? status}`, action: cur ? toSummary(cur) : undefined };
  }

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
    // Market drafts are priced from the live quote at confirm time; only a
    // pending order carries its own price.
    requestedPrice: row.orderType && !row.orderType.endsWith("_MARKET") ? row.requestedPrice ?? null : null,
    stopLoss: row.stopLoss ?? null,
    takeProfit: row.takeProfit ?? null,
    origin: row.source === "ai_suggested" ? "ruby" : row.source === "decision_engine" ? "automation" : "manual",
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

  // Hand the action to its venue's governed queue (lib/tradeAction/route.ts):
  // DEMO → demo command queue, LIVE → live pipeline, position ops →
  // governedOps. Each runs its own gates and the Risk Governor again on the
  // exact command; a refusal there rejects the action with that reason.
  let routed: RouteResult;
  try {
    routed = await routeConfirmedAction(routable(row, opts.sourcePage));
  } catch {
    routed = { ok: false, venue: null, commandId: null, reason: "VENUE_QUEUE_FAILED" };
  }

  if (!routed.ok) {
    const failed = routed.reason === "VENUE_QUEUE_FAILED";
    await db.update(tradeActionRequestsTable).set({
      status: failed ? "failed" : "rejected",
      rejectionReason: routed.message ?? `The ${routed.venue ?? "broker"} queue refused this action: ${routed.reason}.`,
      guardResult: guard, executionVenue: routed.venue, venueCommandId: routed.commandId,
      updatedAt: new Date(),
    }).where(eq(tradeActionRequestsTable.id, row.id));
    await writeActionTimeline({
      userId: row.userId, tradeKey: row.tradeKey, actionId: row.id,
      actionType: row.actionType as ActionType,
      eventType: failed ? "action_failed" : "action_guard_rejected",
      severity: failed ? "urgent" : "warning",
      title: failed ? "Queue failed" : `Refused by the ${routed.venue} queue`,
      message: routed.reason,
      source: "system",
      context: { venue: routed.venue, venueCommandId: routed.commandId },
    });
    await notifyAction({
      userId: row.userId, actionId: row.id, actionType: row.actionType as ActionType,
      tradeKey: row.tradeKey, symbol: row.symbol, status: failed ? "failed" : "rejected",
      kind: "action_rejected",
      title: `Action rejected: ${humanize(row.actionType as ActionType)}`,
      message: `The ${routed.venue ?? "broker"} queue refused this action (${routed.reason}).`,
    });
    const [updated] = await db.select().from(tradeActionRequestsTable).where(eq(tradeActionRequestsTable.id, row.id)).limit(1);
    return { ok: false, error: failed ? "queue_failed" : "venue_rejected", action: updated ? toSummary(updated) : undefined };
  }

  // SIMULATED open (owner decision 13): the PAPER venue filled it at a real
  // quote, so the action is executed — as a paper order, never a broker one.
  if (routed.paper) {
    const p = routed.paper;
    const done: ActionStatus = canTransition("queued", "executed") ? "executed" : "queued";
    await db.update(tradeActionRequestsTable).set({
      status: done, guardResult: guard, executionVenue: "PAPER", venueCommandId: routed.commandId,
      fillPrice: p.fillPrice, filledLotSize: p.lots, executedAt: new Date(),
      brokerMessage: `${p.label} Paper order #${p.paperOrderId}${p.priceSource ? `, priced from ${p.priceSource} at ${p.quoteAt}` : ""}.`,
      updatedAt: new Date(),
    }).where(eq(tradeActionRequestsTable.id, row.id));
    await writeActionTimeline({
      userId: row.userId, tradeKey: row.tradeKey, actionId: row.id,
      actionType: row.actionType as ActionType,
      eventType: "action_queued",
      severity: "info",
      title: "Simulated paper order booked",
      message: `${p.label} Paper order #${p.paperOrderId} ${p.side} ${p.lots} ${p.symbol} @ ${p.fillPrice}.`,
      source: "system",
      context: { venue: "PAPER", venueCommandId: routed.commandId, priceSource: p.priceSource, quoteAt: p.quoteAt, replayed: p.replayed },
    });
    await notifyAction({
      userId: row.userId, actionId: row.id, actionType: row.actionType as ActionType,
      tradeKey: row.tradeKey, symbol: row.symbol, status: done,
      kind: "action_queued",
      title: `Simulated: ${humanize(row.actionType as ActionType)}`,
      message: `${p.label} Paper order #${p.paperOrderId}.`,
    });
    const [updated] = await db.select().from(tradeActionRequestsTable).where(eq(tradeActionRequestsTable.id, row.id)).limit(1);
    return { ok: true, action: toSummary(updated!), paper: p };
  }

  // guard_checking → queued → sent_to_mt5: a dispatched command passes both.
  const nextStatus: ActionStatus = routed.sent && canTransition("queued", "sent_to_mt5") ? "sent_to_mt5" : "queued";
  await db.update(tradeActionRequestsTable).set({
    status: nextStatus, guardResult: guard, executionVenue: routed.venue, venueCommandId: routed.commandId,
    updatedAt: new Date(),
  }).where(eq(tradeActionRequestsTable.id, row.id));

  await writeActionTimeline({
    userId: row.userId, tradeKey: row.tradeKey, actionId: row.id,
    actionType: row.actionType as ActionType,
    eventType: "action_queued",
    severity: "info",
    title: routed.sent ? `Sent to the ${routed.venue} broker` : "Action recorded",
    message: routed.commandId ? `${routed.venue} command ${routed.commandId}` : "Simulated: no broker command.",
    source: "system",
    context: { venue: routed.venue, venueCommandId: routed.commandId },
  });

  await notifyAction({
    userId: row.userId, actionId: row.id, actionType: row.actionType as ActionType,
    tradeKey: row.tradeKey, symbol: row.symbol, status: nextStatus,
    kind: "action_queued",
    title: `Action ${routed.sent ? "sent" : "queued"}: ${humanize(row.actionType as ActionType)}`,
    message: routed.sent ? `Awaiting the ${routed.venue} broker's fill.` : "Simulated action recorded.",
  });

  const [updated] = await db.select().from(tradeActionRequestsTable).where(eq(tradeActionRequestsTable.id, row.id)).limit(1);
  return { ok: true, action: toSummary(updated!) };
}

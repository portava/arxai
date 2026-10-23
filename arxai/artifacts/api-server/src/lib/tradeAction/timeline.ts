// Phase UX8 — Trade Action Center audit timeline.
//
// Reuses the existing `trade_decision_timeline` table so AI assistant and
// trade-detail timeline UIs surface action events alongside decision
// events. Every write is best-effort (try/catch) so timeline failures
// never break action lifecycle progression.

import { db } from "@workspace/db";
import { tradeDecisionTimelineTable } from "@workspace/db/schema";
import { logger } from "../logger.js";
import type { ActionStatus, ActionType } from "./types.js";

export type ActionEventType =
  | "action_drafted"          // any source created a draft
  | "action_reviewed"         // user opened the review modal
  | "action_confirmed"        // user pressed confirm
  | "action_guard_passed"
  | "action_guard_rejected"
  | "action_queued"
  | "action_sent_to_mt5"
  | "action_executed"
  | "action_failed"
  | "action_cancelled"
  | "action_expired";

export async function writeActionTimeline(opts: {
  userId: number;
  tradeKey: string | null;
  actionId: number;
  actionType: ActionType;
  eventType: ActionEventType;
  severity?: "info" | "watch" | "warning" | "urgent";
  title: string;
  message?: string;
  source?: "user" | "ai" | "system" | "engine";
  context?: Record<string, unknown>;
}): Promise<void> {
  // The timeline table requires non-null trade_key. For OPEN actions
  // (no tradeKey yet) we synthesize a tradeKey-like marker so the row
  // remains query-able from per-action UIs without polluting per-trade
  // queries.
  const tk = opts.tradeKey ?? `action_${opts.actionId}`;
  try {
    await db.insert(tradeDecisionTimelineTable).values({
      userId: opts.userId,
      tradeKey: tk,
      eventType: opts.eventType,
      severity: opts.severity ?? "info",
      title: opts.title,
      message: opts.message ?? "",
      source: opts.source ?? "system",
      context: {
        actionId: opts.actionId,
        actionType: opts.actionType,
        ...(opts.context ?? {}),
      },
    });
  } catch (e) {
    logger.warn({ err: e, actionId: opts.actionId, eventType: opts.eventType }, "action_timeline_write_failed");
  }
}

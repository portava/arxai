// Phase UX8 — Trade Action Center: create draft.
//
// SAFETY: createActionDraft NEVER executes anything. It writes one row
// to `trade_action_requests` with status="ai_suggested" (when source is
// the AI or decision engine) or "awaiting_confirmation" (when initiated
// directly by the user via a review button).

import { db } from "@workspace/db";
import { tradeActionRequestsTable, tradeDecisionsTable } from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";
import { resolveUserTrade } from "../trades/resolveTrade.js";
import { writeActionTimeline } from "./timeline.js";
import { notifyAction } from "./notifications.js";
import type { ActionType, RequestedMode, ActionSummary } from "./types.js";

const DRAFT_TTL_MS = 30 * 60 * 1000;

export interface CreateActionDraftInput {
  userId: number;
  actionType: ActionType;
  tradeKey: string | null;
  requestedMode?: RequestedMode;        // default: SIMULATED
  symbol?: string;                      // required when no tradeKey
  side?: "BUY" | "SELL" | null;
  lotSize?: number | null;
  requestedPrice?: number | null;
  stopLoss?: number | null;
  takeProfit?: number | null;
  reason?: string | null;
  source?: "ai_suggested" | "user_initiated" | "decision_engine";
}

export type CreateResult =
  | { ok: true; action: ActionSummary }
  | { ok: false; error: string };

export async function createActionDraft(input: CreateActionDraftInput): Promise<CreateResult> {
  const source = input.source ?? "user_initiated";
  const requestedMode: RequestedMode = input.requestedMode ?? "SIMULATED";

  // Resolve trade for ownership + auto-fill symbol/side/lot when missing.
  let symbol = input.symbol ?? "";
  let side: "BUY" | "SELL" | null = input.side ?? null;
  let lotSize = input.lotSize ?? null;
  let routingMode: string = "UNRESOLVED";

  if (input.tradeKey) {
    const trade = await resolveUserTrade(input.userId, input.tradeKey);
    if (!trade) return { ok: false, error: "trade_not_found_or_not_yours" };
    symbol = trade.symbol;
    side = trade.side;
    lotSize = lotSize ?? trade.lotSize;
    routingMode = trade.routingMode;
  }

  if (!symbol) return { ok: false, error: "symbol_required" };

  // Best-effort: link to latest decision row.
  let aiDecisionId: number | null = null;
  if (input.tradeKey) {
    try {
      const [d] = await db.select({ id: tradeDecisionsTable.id })
        .from(tradeDecisionsTable)
        .where(and(eq(tradeDecisionsTable.userId, input.userId), eq(tradeDecisionsTable.tradeKey, input.tradeKey)))
        .limit(1);
      aiDecisionId = d?.id ?? null;
    } catch { /* non-fatal */ }
  }

  const initialStatus = source === "user_initiated" ? "awaiting_confirmation" : "ai_suggested";
  const expiresAt = new Date(Date.now() + DRAFT_TTL_MS);

  const [inserted] = await db.insert(tradeActionRequestsTable).values({
    userId: input.userId,
    tradeKey: input.tradeKey ?? null,
    actionType: input.actionType,
    requestedMode,
    accountType: "unknown",
    routingMode,
    symbol,
    side: side ?? null,
    lotSize: lotSize ?? null,
    requestedPrice: input.requestedPrice ?? null,
    stopLoss: input.stopLoss ?? null,
    takeProfit: input.takeProfit ?? null,
    reason: input.reason ?? null,
    source,
    status: initialStatus,
    confirmationRequired: true,
    confirmedByUser: false,
    aiDecisionId,
    expiresAt,
  }).returning();

  if (!inserted) return { ok: false, error: "insert_failed" };

  await writeActionTimeline({
    userId: input.userId,
    tradeKey: input.tradeKey,
    actionId: inserted.id,
    actionType: input.actionType,
    eventType: "action_drafted",
    severity: "info",
    title: `Action drafted: ${input.actionType}`,
    message: input.reason ?? "",
    source: source === "ai_suggested" ? "ai" : (source === "decision_engine" ? "engine" : "user"),
    context: { initialStatus, requestedMode },
  });

  await notifyAction({
    userId: input.userId,
    actionId: inserted.id,
    actionType: input.actionType,
    tradeKey: input.tradeKey,
    symbol,
    status: initialStatus,
    kind: source === "ai_suggested" ? "action_suggested" : "action_awaiting_confirmation",
    title: source === "ai_suggested" ? `ARX suggests reviewing a ${humanize(input.actionType)}` : `Action awaiting your confirmation`,
    message: input.reason ?? `Open the Action Center to review.`,
    recommendedAction: "Open the Action Center to review.",
  });

  return { ok: true, action: toSummary(inserted) };
}

export function toSummary(row: typeof tradeActionRequestsTable.$inferSelect): ActionSummary {
  return {
    id: row.id,
    userId: row.userId,
    tradeKey: row.tradeKey,
    actionType: row.actionType as ActionType,
    requestedMode: row.requestedMode as RequestedMode,
    accountType: row.accountType,
    routingMode: row.routingMode,
    symbol: row.symbol,
    side: row.side,
    lotSize: row.lotSize,
    requestedPrice: row.requestedPrice,
    stopLoss: row.stopLoss,
    takeProfit: row.takeProfit,
    reason: row.reason,
    source: row.source,
    status: row.status as ActionSummary["status"],
    confirmationRequired: row.confirmationRequired,
    confirmedByUser: row.confirmedByUser,
    confirmedAt: row.confirmedAt?.toISOString() ?? null,
    rejectionReason: row.rejectionReason,
    guardResult: (row.guardResult as ActionSummary["guardResult"]) ?? null,
    mt5Ticket: row.mt5Ticket,
    tradeCommandId: row.tradeCommandId,
    aiDecisionId: row.aiDecisionId,
    mt5OrderTicket: row.mt5OrderTicket ?? null,
    mt5PositionTicket: row.mt5PositionTicket ?? null,
    fillPrice: row.fillPrice ?? null,
    slippage: row.slippage ?? null,
    filledLotSize: row.filledLotSize ?? null,
    brokerMessage: row.brokerMessage ?? null,
    errorCode: row.errorCode ?? null,
    executedAt: row.executedAt?.toISOString() ?? null,
    staleAt: row.staleAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function humanize(t: ActionType): string {
  switch (t) {
    case "OPEN": return "open trade";
    case "CLOSE": return "full close";
    case "PARTIAL_CLOSE": return "partial close";
    case "MOVE_STOP": return "move stop";
    case "TRAIL_STOP": return "trail stop";
    case "MODIFY_TP_SL": return "TP/SL modify";
    case "CANCEL_ORDER": return "order cancel";
  }
}

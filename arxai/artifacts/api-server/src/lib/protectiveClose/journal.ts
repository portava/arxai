// Phase 13 — Protective Auto-Close: append-only decision journal.
//
// SAFETY: Every protective-close evaluation lands here BEFORE any action
// is attempted. Cross-user reads impossible (queries always filter userId).

import { db } from "@workspace/db";
import { protectiveCloseDecisionsTable, type ProtectiveCloseDecision } from "@workspace/db/schema";
import { and, desc, eq, gte } from "drizzle-orm";
import type { DecisionOutput } from "./decide.js";

export async function recordDecision(args: {
  userId: number;
  tradeKey: string;
  symbol: string;
  decision: DecisionOutput;
  actionTakenActionId?: number | null;
  mt5Result?: unknown;
}): Promise<ProtectiveCloseDecision> {
  const [row] = await db.insert(protectiveCloseDecisionsTable).values({
    userId: args.userId,
    tradeKey: args.tradeKey,
    symbol: args.symbol,
    decision: args.decision.decision,
    decisionReason: args.decision.reason,
    confidence: args.decision.confidence,
    dataStatus: args.decision.dataStatus,
    reversalSignals: args.decision.reversalSignals,
    invalidationLevel: args.decision.invalidationLevel,
    currentPnl: args.decision.currentPnl,
    peakPnl: args.decision.peakPnl,
    givebackPercent: args.decision.givebackPercent,
    suggestedClosePercent: args.decision.suggestedClosePercent,
    suggestedAction: args.decision.suggestedAction,
    userInactive: args.decision.userInactive,
    inactiveDurationMs: args.decision.inactiveDurationMs,
    userOptedIn: args.decision.userOptedIn,
    guardsPassed: args.decision.guardsPassed,
    blockedReason: args.decision.blockedReason,
    actionTakenActionId: args.actionTakenActionId ?? null,
    mt5Result: (args.mt5Result as object | null | undefined) ?? null,
  }).returning();
  return row!;
}

/**
 * Has a protective close attempt already been made on this trade within
 * the cooldown window? Used by decide() to enforce DUPLICATE_WITHIN_COOLDOWN.
 */
export async function hasRecentAttempt(userId: number, tradeKey: string, cooldownMin: number): Promise<boolean> {
  const since = new Date(Date.now() - cooldownMin * 60_000);
  // SAFETY: cooldown counts ONLY real close attempts — i.e. rows where
  // the engine actually drafted/queued an action (actionTakenActionId
  // non-null) OR the decision was AUTO_CLOSE_ELIGIBLE. NO_ACTION /
  // ALERT_ONLY / RECOMMEND_* / BLOCKED rows do NOT count, otherwise
  // every evaluation would block the next one and suppress ALERT_ONLY.
  const rows = await db.select({
    id: protectiveCloseDecisionsTable.id,
    decision: protectiveCloseDecisionsTable.decision,
    actionTakenActionId: protectiveCloseDecisionsTable.actionTakenActionId,
  })
    .from(protectiveCloseDecisionsTable)
    .where(and(
      eq(protectiveCloseDecisionsTable.userId, userId),
      eq(protectiveCloseDecisionsTable.tradeKey, tradeKey),
      gte(protectiveCloseDecisionsTable.createdAt, since),
    ));
  for (const r of rows) {
    if (r.actionTakenActionId != null) return true;
    if (r.decision === "AUTO_CLOSE_ELIGIBLE") return true;
  }
  return false;
}

export async function listRecentDecisions(userId: number, limit = 50): Promise<ProtectiveCloseDecision[]> {
  return db.select().from(protectiveCloseDecisionsTable)
    .where(eq(protectiveCloseDecisionsTable.userId, userId))
    .orderBy(desc(protectiveCloseDecisionsTable.createdAt))
    .limit(Math.min(limit, 200));
}

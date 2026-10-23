// Phase UX7 — Trade decision persistence + prior loader.

import { db } from "@workspace/db";
import { tradeDecisionsTable } from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";
import type { TradeDecision } from "./types.js";

export interface PersistInput {
  userId: number;
  tradeKey: string;
  routingMode: string;
  symbol: string;
  side: "BUY" | "SELL";
  decision: TradeDecision;
}

export async function upsertTradeDecision(input: PersistInput) {
  const { userId, tradeKey, routingMode, symbol, side, decision } = input;
  const row = {
    userId, tradeKey, routingMode, symbol, side,
    decisionLabel: decision.decisionLabel,
    decisionAction: decision.decisionAction,
    confidenceScore: decision.confidenceScore,
    urgencyScore: decision.urgencyScore,
    riskScore: decision.riskScore,
    reasonSummary: decision.reasonSummary,
    mainReason: decision.mainReason,
    supportingReasons: decision.supportingReasons as unknown as Record<string, unknown>,
    invalidationLevel: decision.invalidationLevel,
    protectProfitLevel: decision.protectProfitLevel,
    continuationLevel: decision.continuationLevel,
    suggestedButton: decision.suggestedButton,
    requiresConfirmation: decision.requiresConfirmation,
    dataQuality: decision.dataQuality as unknown as Record<string, unknown>,
    source: decision.source,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const [up] = await db.insert(tradeDecisionsTable).values(row as never)
    .onConflictDoUpdate({
      target: [tradeDecisionsTable.userId, tradeDecisionsTable.tradeKey],
      set: { ...row, updatedAt: new Date() } as never,
    })
    .returning();
  return up;
}

export interface PriorDecision {
  decisionLabel: string | null;
  decisionAction: string | null;
  urgencyScore: number | null;
  confidenceScore: number | null;
  dataQuality: unknown | null;
}

export async function loadPriorTradeDecision(
  userId: number, tradeKey: string,
): Promise<PriorDecision | null> {
  const [r] = await db.select({
    decisionLabel: tradeDecisionsTable.decisionLabel,
    decisionAction: tradeDecisionsTable.decisionAction,
    urgencyScore: tradeDecisionsTable.urgencyScore,
    confidenceScore: tradeDecisionsTable.confidenceScore,
    dataQuality: tradeDecisionsTable.dataQuality,
  }).from(tradeDecisionsTable)
    .where(and(
      eq(tradeDecisionsTable.userId, userId),
      eq(tradeDecisionsTable.tradeKey, tradeKey),
    ))
    .limit(1);
  return r ?? null;
}

export async function loadAllActiveDecisions(userId: number) {
  return db.select().from(tradeDecisionsTable)
    .where(eq(tradeDecisionsTable.userId, userId));
}

// Task #199 — Ruby Quality: record-on-appear tracker.
//
// SAFETY / SCOPE:
//   - OBSERVATION ONLY. Recording a signal NEVER places, modifies, or closes a
//     trade and never touches the MT5 bridge or the 16-gate live pipeline.
//   - Per-user isolation: every row is scoped by userId.
//   - Idempotent: a repeated appearance of the same signal (same
//     scannerSignalId, or the same symbol/timeframe/decision within a short
//     dedupe window) does NOT create a duplicate row.
//   - TRUTH-LOCK: the row is locked at creation so its "at signal" snapshot can
//     never be rewritten later.

import { randomUUID } from "node:crypto";
import { and, desc, eq, gte } from "drizzle-orm";
import {
  db,
  rubySignalOutcomesTable,
  type RubySignalOutcomeRow,
} from "@workspace/db";
import { buildSignalOutcomeLock } from "@workspace/domain/ruby-quality";

export interface RecordSignalInput {
  userId: number;
  symbol: string;
  timeframe?: string | null;
  session?: string | null;
  direction?: string | null; // BUY | SELL | NONE
  decision: string;          // approve | caution | reject | no_trade | observe
  confidenceScore?: number;
  edgeScore?: number | null;
  flameStage?: string | null;
  newsNearby?: boolean;
  newsWindowMinutes?: number | null;
  spreadAtSignal?: number | null;
  expectedSlippage?: number | null;
  expectedStartDrawdown?: number | null;
  entryPrice?: number | null;
  stopLoss?: number | null;
  takeProfit?: number | null;
  scannerSignalId?: string | null;
  predictionId?: string | null;
  explanationUsed?: boolean;
  /** Dedupe window for signals without a scannerSignalId. Default 5 minutes. */
  dedupeWindowMs?: number;
}

const DEFAULT_DEDUPE_MS = 5 * 60 * 1000;

/**
 * Record a Ruby signal the moment it appears, returning the (new or existing)
 * locked outcome row. Idempotent and per-user isolated.
 */
export async function recordSignalOnAppear(
  input: RecordSignalInput,
): Promise<RubySignalOutcomeRow> {
  // 1. Exact idempotency on a provided scanner signal id.
  if (input.scannerSignalId) {
    const existing = await db
      .select()
      .from(rubySignalOutcomesTable)
      .where(and(
        eq(rubySignalOutcomesTable.userId, input.userId),
        eq(rubySignalOutcomesTable.scannerSignalId, input.scannerSignalId),
      ))
      .limit(1);
    if (existing[0]) return existing[0];
  } else {
    // 2. Window dedupe for on-demand reads with no stable signal id.
    const windowStart = new Date(Date.now() - (input.dedupeWindowMs ?? DEFAULT_DEDUPE_MS));
    const recent = await db
      .select()
      .from(rubySignalOutcomesTable)
      .where(and(
        eq(rubySignalOutcomesTable.userId, input.userId),
        eq(rubySignalOutcomesTable.symbol, input.symbol),
        eq(rubySignalOutcomesTable.timeframe, input.timeframe ?? ""),
        eq(rubySignalOutcomesTable.decision, input.decision),
        gte(rubySignalOutcomesTable.createdAt, windowStart),
      ))
      .orderBy(desc(rubySignalOutcomesTable.createdAt))
      .limit(1);
    if (recent[0]) return recent[0];
  }

  const now = new Date();
  const lock = buildSignalOutcomeLock(now);
  const inserted = await db
    .insert(rubySignalOutcomesTable)
    .values({
      outcomeId: randomUUID(),
      userId: input.userId,
      scannerSignalId: input.scannerSignalId ?? null,
      predictionId: input.predictionId ?? null,
      symbol: input.symbol,
      timeframe: input.timeframe ?? "",
      session: input.session ?? null,
      direction: input.direction ?? null,
      decision: input.decision,
      confidenceScore: input.confidenceScore ?? 0,
      edgeScore: input.edgeScore ?? null,
      flameStage: input.flameStage ?? null,
      newsNearby: input.newsNearby ?? false,
      newsWindowMinutes: input.newsWindowMinutes ?? null,
      spreadAtSignal: input.spreadAtSignal ?? null,
      expectedSlippage: input.expectedSlippage ?? null,
      expectedStartDrawdown: input.expectedStartDrawdown ?? null,
      entryPrice: input.entryPrice ?? null,
      stopLoss: input.stopLoss ?? null,
      takeProfit: input.takeProfit ?? null,
      explanationUsed: input.explanationUsed ?? false,
      outcomeStatus: "PENDING",
      locked: lock.locked,
      lockedAt: lock.lockedAt,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return inserted[0];
}

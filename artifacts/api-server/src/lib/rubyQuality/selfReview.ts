// Task #199 — Ruby Quality: post-trade self-review generator.
//
// SAFETY / SCOPE:
//   - APPEND-ONLY. A self-review is generated once a tracked signal RESOLVES on
//     real evidence. It never edits the locked snapshot and never touches any
//     execution path. Idempotent on outcomeId (one review per outcome).
//   - The user-facing `userSummary` is plain language with NO internal enum
//     tokens. The `adminDetail` jsonb is ONLY ever returned to ADMIN/OWNER
//     sessions — never to users or investors.

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  db,
  rubySignalOutcomesTable,
  rubySignalReviewsTable,
  tradesTable,
  type RubySignalOutcomeRow,
  type RubySignalReviewRow,
} from "@workspace/db";
import {
  buildSignalSelfReview,
  type ExitReason,
  type SignalOutcomeStatus,
  type TimingClass,
} from "@workspace/domain/ruby-quality";
import { analyzeTradeOutcome } from "../aiLearning/tradeOutcomeAnalyzer.js";

/** Generate (or return the existing) self-review for a resolved outcome row. */
export async function generateSelfReview(
  row: RubySignalOutcomeRow,
): Promise<RubySignalReviewRow | null> {
  // Only resolved-on-evidence rows get a review; PENDING/UNRESOLVED never do.
  if (row.outcomeStatus === "PENDING" || row.outcomeStatus === "UNRESOLVED") return null;

  const existing = await db.select().from(rubySignalReviewsTable)
    .where(eq(rubySignalReviewsTable.outcomeId, row.outcomeId)).limit(1);
  if (existing[0]) return existing[0];

  // Optional analyzer tags from the matched closed trade (admin detail only).
  let mistakeTags: string[] = [];
  let successTags: string[] = [];
  if (row.tradeId != null) {
    const t = await db.select().from(tradesTable)
      .where(eq(tradesTable.id, row.tradeId)).limit(1);
    const trade = t[0];
    if (trade && trade.pnl != null && (trade.pnlStatus == null || trade.pnlStatus === "COMPUTED")) {
      const analysis = analyzeTradeOutcome({
        symbol: trade.symbol,
        strategy: trade.strategy,
        confidence: trade.confidence,
        entry: trade.entryPrice,
        stopLoss: trade.stopLoss,
        takeProfit: trade.takeProfit,
        exit: trade.status === "CLOSED_WIN" ? trade.takeProfit : trade.stopLoss,
        profitLoss: trade.pnl,
        session: row.session ?? undefined,
        newsRisk: row.newsNearby ? "high" : "none",
      });
      mistakeTags = analysis.mistakeTags;
      successTags = analysis.successTags;
    }
  }

  const review = buildSignalSelfReview({
    symbol: row.symbol,
    direction: row.direction,
    decision: row.decision,
    outcomeStatus: row.outcomeStatus as SignalOutcomeStatus,
    pnlR: row.pnlR,
    userEntered: row.userEntered,
    explanationUsed: row.explanationUsed,
    timingClass: (row.timingClass as TimingClass | null) ?? null,
    newsNearby: row.newsNearby,
    spreadAtSignal: row.spreadAtSignal,
    expectedSlippage: row.expectedSlippage,
    actualSlippage: row.actualSlippage,
    expectedStartDrawdown: row.expectedStartDrawdown,
    actualStartDrawdown: row.actualStartDrawdown,
    maxFavorableExcursion: row.maxFavorableExcursion,
    maxAdverseExcursion: row.maxAdverseExcursion,
    exitReason: (row.exitReason as ExitReason | null) ?? null,
    confidenceScore: row.confidenceScore,
    edgeScore: row.edgeScore,
    mistakeTags,
    successTags,
  });

  const inserted = await db.insert(rubySignalReviewsTable).values({
    reviewId: randomUUID(),
    outcomeId: row.outcomeId,
    userId: row.userId,
    reviewType: review.reviewType,
    outcomeStatus: row.outcomeStatus,
    userSummary: review.userSummary,
    adminDetail: review.adminDetail as unknown as Record<string, unknown>,
  }).onConflictDoNothing({ target: rubySignalReviewsTable.outcomeId }).returning();

  if (inserted[0]) return inserted[0];
  const after = await db.select().from(rubySignalReviewsTable)
    .where(eq(rubySignalReviewsTable.outcomeId, row.outcomeId)).limit(1);
  return after[0] ?? null;
}

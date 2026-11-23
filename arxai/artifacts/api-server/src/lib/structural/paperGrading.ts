import { and, asc, eq, gt, sql } from "drizzle-orm";
import { db, chartDecisionReceiptsTable as receipts, chartDecisionOutcomesTable as outcomes } from "@workspace/db";
import { settledPaperGrade, type ForecastPaperInstruction } from "@workspace/domain/structural";
import { resolveDerivSymbol } from "../data/providers/derivProvider.js";
import { publicPaperBrackets } from "../tradeEngine/publicPaperBrackets.js";
import { structuralRepository } from "./repository.js";
import { logger } from "../logger.js";

export function gradePublicForecastOrder(symbol: string, plan: ForecastPaperInstruction, publishedAt: number, now: number) {
  const market = resolveDerivSymbol(symbol);
  if (!market || !/^V(10|25|50|75|100)(_1S)?$/.test(market.symbol)) return undefined;
  return publicPaperBrackets.gradeTicket(market.derivId, plan, publishedAt, now);
}

/** Paper tickets can settle on the very next tick or well after the direction
 * window closes. Page over the issue markers independently of direction grades
 * and of the 250 most recent forecasts shown in the chart panel. */
export async function gradePublishedPaperOrders(now: number, lookbackMs: number, grade = gradePublicForecastOrder) {
  const result = { checked: 0, saved: 0, failed: 0 };
  let cursor = 0;
  const issuedAt = sql<number>`(${outcomes.evidence} ->> 'at')::double precision`;
  for (;;) {
    const tickets = await db.select({
      marker: outcomes.id, id: receipts.receiptId, userId: outcomes.userId, symbol: receipts.symbol,
      publishedAt: issuedAt, plan: sql<ForecastPaperInstruction>`${receipts.intelligenceSnapshot} #> '{forecast,paperInstruction}'`,
    }).from(outcomes).innerJoin(receipts, and(eq(receipts.receiptId, outcomes.receiptRef), eq(receipts.userId, outcomes.userId)))
      .where(and(eq(outcomes.kind, "STRUCTURAL_PAPER_ISSUED"), eq(receipts.source, "structural_forecast"),
        gt(outcomes.id, cursor), sql`${issuedAt} between ${now-lookbackMs} and ${now}`,
        sql`not exists (select 1 from ${outcomes} as settled where settled.receipt_ref = ${outcomes.receiptRef}
          and settled.user_id = ${outcomes.userId} and settled.kind = 'STRUCTURAL_PAPER_RESULT')`))
      .orderBy(asc(outcomes.id)).limit(100);
    for (const t of tickets) {
      cursor = t.marker;
      if (!t.symbol || t.userId == null || !t.plan) continue;
      result.checked++;
      try {
        const value = grade(t.symbol, t.plan, t.publishedAt, now);
        if (value && settledPaperGrade(value)) {
          await structuralRepository.savePaperGrade!(t.userId, t.id, value);
          result.saved++;
        }
      } catch (err) {
        result.failed++;
        logger.warn({ err, symbol: t.symbol }, "[structuralGrader] paper ticket grading failed");
      }
    }
    if (tickets.length < 100) return result;
  }
}

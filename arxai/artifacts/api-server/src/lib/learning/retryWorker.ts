// A persisted auto-debrief is the durable retry source. Only the exact stored
// outcome can teach shared memory; a committed learning event makes retries no-op.
import { and, asc, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";
import { db, learningEventsTable, postTradeDebriefsTable } from "@workspace/db";
import { processLearningPayload, type LearningPayload } from "../learningEngine.js";
import { logger } from "../logger.js";

export async function retryPendingLearning(afterId = 0, limit = 25) {
  const batchSize = Number.isInteger(limit) ? Math.max(1, Math.min(100, limit)) : 25;
  const rows = await db.select({ id: postTradeDebriefsTable.id, userId: postTradeDebriefsTable.userId, payload: postTradeDebriefsTable.learningPayload, tradeId: postTradeDebriefsTable.tradeId, createdBy: postTradeDebriefsTable.createdBy, meta: postTradeDebriefsTable.autoMeta })
    .from(postTradeDebriefsTable).leftJoin(learningEventsTable, eq(learningEventsTable.debriefId, postTradeDebriefsTable.id))
    .where(and(gt(postTradeDebriefsTable.id, afterId), isNotNull(postTradeDebriefsTable.userId), isNull(learningEventsTable.id),
      sql`${postTradeDebriefsTable.learningPayload}->>'ready_for_learning' = 'true'`))
    .orderBy(asc(postTradeDebriefsTable.id)).limit(batchSize);
  let processed = 0, failed = 0;
  for (const row of rows) {
    let payload = row.payload as unknown as LearningPayload;
    const meta = row.meta as Record<string, unknown> | null;
    // Older versions committed a system draft before patching its ID. Repair
    // only this exact provenance-backed shape, never an arbitrary caller ID.
    if (payload.debrief_id === 0 && row.createdBy === "SYSTEM_AUTO_DEBRIEF" &&
        payload.trade_id === row.tradeId && meta?.trade_id === row.tradeId && meta?.created_by === "SYSTEM_AUTO_DEBRIEF") {
      const canonical = { ...payload, debrief_id: row.id };
      const updated = await db.update(postTradeDebriefsTable).set({ learningPayload: canonical, updatedAt: new Date() })
        .where(and(eq(postTradeDebriefsTable.id, row.id), eq(postTradeDebriefsTable.learningPayload, row.payload)))
        .returning({ id: postTradeDebriefsTable.id });
      if (!updated.length) { failed++; continue; }
      payload = canonical;
    }
    const result = await processLearningPayload(payload, { ownerUserId: row.userId! });
    if (result.status === "processed") processed++;
    else if (result.status !== "skipped_already_processed") failed++;
  }
  // Advance even across a bad row, so it cannot starve later outcomes. Revisit
  // failures on the next sweep; rows and successful receipts survive restarts.
  return { attempted: rows.length, processed, failed, cursor: rows.length === batchSize ? rows.at(-1)!.id : 0 };
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startScopedLearningRetryWorker() {
  if (timer) return;
  let inFlight = false, cursor = 0;
  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const result = await retryPendingLearning(cursor);
      cursor = result.cursor;
      if (result.attempted) logger.info(result, "scoped learning retry sweep");
    } catch (error) { logger.warn({ error: String(error) }, "scoped learning retry sweep failed"); }
    finally { inFlight = false; }
  };
  timer = setInterval(() => { void tick(); }, 60_000);
  timer.unref();
  void tick();
}
export function stopScopedLearningRetryWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}

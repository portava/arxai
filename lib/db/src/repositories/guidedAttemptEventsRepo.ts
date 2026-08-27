// Phase 6 — the guided forensic ledger.
//
// APPEND-ONLY. Registered with check-vault-mutations, so an UPDATE or DELETE
// here fails CI. Mutating a row would rewrite what a trade attempt actually
// did, which is the only thing this table is for.

import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "../index";
import { guidedAttemptEventsTable } from "../schema/phase6GuidedExecution";

export type GuidedAttemptEventRow = typeof guidedAttemptEventsTable.$inferSelect;

/**
 * Append one event to an attempt.
 *
 * The sequence number is derived INSIDE the insert from the current max for
 * this intent, so two concurrent writers cannot both claim the same slot:
 * (intent_id, sequence_no) is unique, and the loser gets a unique violation
 * rather than silently overwriting the other's record of what happened.
 *
 * That failure is deliberately NOT swallowed. An audit write that fails
 * silently leaves a gap exactly where the forensic record matters most.
 */
export async function appendGuidedEvent(
  values: Omit<typeof guidedAttemptEventsTable.$inferInsert, "sequenceNo">,
): Promise<GuidedAttemptEventRow> {
  const rows = await db.insert(guidedAttemptEventsTable).values({
    ...values,
    sequenceNo: sql`(
      select coalesce(max(sequence_no), 0) + 1
      from guided_attempt_events
      where intent_id = ${values.intentId}
    )` as unknown as number,
  }).returning();
  const row = rows[0];
  if (!row) throw new Error("GUIDED_ATTEMPT_EVENT_INSERT_RETURNED_NO_ROW");
  return row;
}

/** Every event for one attempt, in order. The forensic reconstruction query. */
export async function listAttemptEvents(intentId: string): Promise<GuidedAttemptEventRow[]> {
  return db.select().from(guidedAttemptEventsTable)
    .where(eq(guidedAttemptEventsTable.intentId, intentId))
    .orderBy(asc(guidedAttemptEventsTable.sequenceNo));
}

/** Scoped to the owner — the journal surface must not leak another user's attempt. */
export async function listUserAttemptEvents(
  userId: number,
  intentId: string,
): Promise<GuidedAttemptEventRow[]> {
  return db.select().from(guidedAttemptEventsTable)
    .where(and(
      eq(guidedAttemptEventsTable.userId, userId),
      eq(guidedAttemptEventsTable.intentId, intentId),
    ))
    .orderBy(asc(guidedAttemptEventsTable.sequenceNo));
}

/** Recent attempts for the journal list. Owner-scoped in the query. */
export async function listRecentAttemptsForUser(
  userId: number,
  limit = 50,
): Promise<GuidedAttemptEventRow[]> {
  return db.select().from(guidedAttemptEventsTable)
    .where(eq(guidedAttemptEventsTable.userId, userId))
    .orderBy(sql`occurred_at desc`)
    .limit(limit);
}

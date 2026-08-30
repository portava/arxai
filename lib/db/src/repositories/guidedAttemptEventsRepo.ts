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

/**
 * Append the ONE RECONCILED event for an attempt, idempotently.
 *
 * The partial unique index guided_attempt_events_reconciled_uq (one RECONCILED
 * per intent_id) makes the race a database fact: two concurrent reconcilers
 * cannot both settle the same attempt. ON CONFLICT DO NOTHING turns the
 * loser's insert into "already" — the winner's venue evidence stands, and a
 * second, possibly different settlement record can never be written.
 *
 * This is NOT a mutation of the ledger (check-vault-mutations still forbids
 * UPDATE/DELETE here): it is one append whose at-most-once property lives in
 * the schema.
 */
export async function appendReconciledOnce(values: {
  intentId: string;
  ticketId: string;
  userId: number;
  constitutionVersion: number;
  venueContractRef: string;
  /** Verbatim from the venue's settled read. Null = venue stated no number. */
  venueProfitUsd: number | null;
  detail: string;
}): Promise<"appended" | "already"> {
  const rows = await db.insert(guidedAttemptEventsTable).values({
    intentId: values.intentId,
    ticketId: values.ticketId,
    userId: values.userId,
    liveCommandId: null,
    eventType: "RECONCILED",
    constitutionVersion: values.constitutionVersion,
    venueContractRef: values.venueContractRef,
    venueProfitUsd: values.venueProfitUsd,
    detail: values.detail,
    sequenceNo: sql`(
      select coalesce(max(sequence_no), 0) + 1
      from guided_attempt_events
      where intent_id = ${values.intentId}
    )` as unknown as number,
  }).onConflictDoNothing({
    target: [guidedAttemptEventsTable.intentId],
    where: sql`event_type = 'RECONCILED'`,
  }).returning({ id: guidedAttemptEventsTable.id });
  return rows.length > 0 ? "appended" : "already";
}

/**
 * Attempts that EXECUTED (venue contract exists) and have no RECONCILED event
 * — the reconciler's work list. Owner-scoped.
 */
export async function listUnreconciledExecutedForUser(userId: number): Promise<Array<{
  intentId: string;
  ticketId: string;
  venueContractRef: string | null;
  constitutionVersion: number;
}>> {
  const rows = await db.select({
    intentId: guidedAttemptEventsTable.intentId,
    ticketId: guidedAttemptEventsTable.ticketId,
    venueContractRef: guidedAttemptEventsTable.venueContractRef,
    constitutionVersion: guidedAttemptEventsTable.constitutionVersion,
  })
    .from(guidedAttemptEventsTable)
    .where(and(
      eq(guidedAttemptEventsTable.userId, userId),
      eq(guidedAttemptEventsTable.eventType, "EXECUTED"),
      sql`not exists (
        select 1 from guided_attempt_events r
        where r.intent_id = ${guidedAttemptEventsTable.intentId}
          and r.event_type = 'RECONCILED'
      )`,
    ))
    .orderBy(asc(guidedAttemptEventsTable.occurredAt));
  return rows;
}

/**
 * Loss state derived from venue-settled results ONLY: the trailing run of
 * consecutive venue-confirmed losses, and today's summed venue-confirmed
 * losses (wins never offset — the loss cap is a ceiling, not a net).
 * A RECONCILED row whose venue_profit_usd is NULL is treated as a LOSS for
 * streak purposes: the venue confirmed settlement without stating a number,
 * and assuming it was a win is the falsely-certain direction.
 */
export async function reconciledLossStateForUser(
  userId: number,
  since: Date,
): Promise<{ consecutiveLosses: number; lossesSinceUsd: number; lastLossAtIso: string | null }> {
  const rows = await db.select({
    profit: guidedAttemptEventsTable.venueProfitUsd,
    at: guidedAttemptEventsTable.occurredAt,
  })
    .from(guidedAttemptEventsTable)
    .where(and(
      eq(guidedAttemptEventsTable.userId, userId),
      eq(guidedAttemptEventsTable.eventType, "RECONCILED"),
    ))
    .orderBy(sql`occurred_at desc`)
    .limit(200);

  let consecutiveLosses = 0;
  for (const r of rows) {
    if (r.profit === null || r.profit < 0) consecutiveLosses++;
    else break;
  }
  let lossesSinceUsd = 0;
  for (const r of rows) {
    if (r.at >= since && r.profit !== null && r.profit < 0) lossesSinceUsd += -r.profit;
  }
  const lastLoss = rows.find((r) => r.profit === null || r.profit < 0);
  return {
    consecutiveLosses,
    lossesSinceUsd,
    lastLossAtIso: lastLoss ? lastLoss.at.toISOString() : null,
  };
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

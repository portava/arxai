// Phase 6 — durable Deriv order intents.
//
// WHY THIS TABLE EXISTS. The transport's req_id is monotonic only within ONE
// transport instance and restarts at 0 for a new one. After a process restart
// it cannot correlate a late reply to anything — the sequence is simply gone.
// This row survives, so a reply arriving after a crash can still be matched to
// the command that caused it.
//
// The write order is the safety property: the intent is persisted BEFORE any
// frame reaches the wire. An order we cannot attribute is worse than an order
// we did not place.

import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../index";
import { derivOrderIntentsTable } from "../schema/phase6GuidedExecution";

export type DerivOrderIntentRow = typeof derivOrderIntentsTable.$inferSelect;

export async function createIntent(
  values: typeof derivOrderIntentsTable.$inferInsert,
): Promise<DerivOrderIntentRow> {
  const rows = await db.insert(derivOrderIntentsTable).values(values).returning();
  const row = rows[0];
  if (!row) throw new Error("DERIV_ORDER_INTENT_INSERT_RETURNED_NO_ROW");
  return row;
}

export async function findIntent(intentId: string): Promise<DerivOrderIntentRow | null> {
  const rows = await db.select().from(derivOrderIntentsTable)
    .where(eq(derivOrderIntentsTable.intentId, intentId)).limit(1);
  return rows[0] ?? null;
}

/**
 * Record that a frame reached the wire, with the correlation key.
 *
 * BOTH reqId and transportInstanceId are required. A bare req_id is ambiguous
 * across a reconnect — instance A's req_id 3 and instance B's req_id 3 are
 * different orders — and matching a late reply to the wrong intent would
 * attribute a real position to a command that never placed it.
 */
export async function markWritten(args: {
  intentId: string;
  reqId: number;
  transportInstanceId: string;
}): Promise<DerivOrderIntentRow | null> {
  if (!Number.isInteger(args.reqId) || args.reqId < 0) return null;
  if (typeof args.transportInstanceId !== "string" || args.transportInstanceId.trim() === "") return null;
  const rows = await db.update(derivOrderIntentsTable)
    .set({
      writeDisposition: "WRITTEN",
      reqId: args.reqId,
      transportInstanceId: args.transportInstanceId,
      attemptedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(
      eq(derivOrderIntentsTable.intentId, args.intentId),
      eq(derivOrderIntentsTable.writeDisposition, "NOT_ATTEMPTED"),
    ))
    .returning();
  return rows[0] ?? null;
}

/** A refusal that happened before anything could be transmitted. */
export async function markRefusedPreTransmission(
  intentId: string,
): Promise<DerivOrderIntentRow | null> {
  const rows = await db.update(derivOrderIntentsTable)
    .set({
      writeDisposition: "REFUSED_PRE_TRANSMISSION",
      resolvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(
      eq(derivOrderIntentsTable.intentId, intentId),
      // NOT_ATTEMPTED, or UNRECORDED with no venue evidence: the pre-wire
      // footprint (see guidedDispatchEntry) marks UNRECORDED before the send,
      // and when the transport then PROVES non-transmission the caller may
      // honestly resolve it — refusing would lock the user out over an order
      // that provably does not exist. The venue-ref guard keeps a resolved
      // contract from ever being "un-happened" this way.
      sql`${derivOrderIntentsTable.writeDisposition} in ('NOT_ATTEMPTED','UNRECORDED')`,
      isNull(derivOrderIntentsTable.venueContractRef),
    ))
    .returning();
  return rows[0] ?? null;
}

/**
 * The write may or may not have gone out and we cannot tell.
 *
 * UNRECORDED is not a failure. It is the disposition that keeps an intent in
 * the unresolved sweep so reconciliation looks for it, rather than writing it
 * off on the strength of not knowing.
 */
export async function markUnrecorded(intentId: string): Promise<DerivOrderIntentRow | null> {
  const rows = await db.update(derivOrderIntentsTable)
    .set({ writeDisposition: "UNRECORDED", attemptedAt: new Date(), updatedAt: new Date() })
    .where(and(
      eq(derivOrderIntentsTable.intentId, intentId),
      sql`${derivOrderIntentsTable.writeDisposition} in ('NOT_ATTEMPTED','WRITTEN')`,
    ))
    .returning();
  return rows[0] ?? null;
}

/** Resolve an intent because the VENUE named a contract for it. */
export async function resolveWithVenueContract(args: {
  intentId: string;
  venueContractRef: string;
  protectionReadback?: unknown;
}): Promise<DerivOrderIntentRow | null> {
  // Positive evidence only. An empty reference is not a reference, and
  // resolving on one would record an order as attributed when it is not.
  if (typeof args.venueContractRef !== "string" || args.venueContractRef.trim() === "") return null;
  const rows = await db.update(derivOrderIntentsTable)
    .set({
      venueContractRef: args.venueContractRef,
      protectionReadback: (args.protectionReadback ?? null) as never,
      resolvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(derivOrderIntentsTable.intentId, args.intentId))
    .returning();
  return rows[0] ?? null;
}

/**
 * Resolve an intent because the VENUE ADJUDICATED a rejection.
 *
 * Distinct from resolveAsProvenAbsent on purpose: a rejection is the venue
 * answering our own req_id with "no" — direct adjudication, stronger evidence
 * than absence from a closed-inclusive read. Recording it through the absence
 * path would claim a read that never happened.
 */
export async function resolveAsVenueRejected(intentId: string): Promise<DerivOrderIntentRow | null> {
  const rows = await db.update(derivOrderIntentsTable)
    .set({ resolvedAt: new Date(), updatedAt: new Date() })
    .where(and(
      eq(derivOrderIntentsTable.intentId, intentId),
      isNull(derivOrderIntentsTable.venueContractRef),
    ))
    .returning();
  return rows[0] ?? null;
}

/**
 * Resolve an intent as ABSENT — no order exists at the venue.
 *
 * `closedInclusive` is required and must be true. Absence from a read that
 * lists only OPEN positions proves nothing: an order that opened and settled is
 * simply missing from it. This is the false-absence defect Phase 5 was hardened
 * against, and the parameter exists so a caller must state which kind of read
 * it performed rather than leaving it implied.
 */
export async function resolveAsProvenAbsent(args: {
  intentId: string;
  closedInclusive: boolean;
}): Promise<DerivOrderIntentRow | null> {
  if (args.closedInclusive !== true) return null;
  const rows = await db.update(derivOrderIntentsTable)
    .set({
      absenceProvenClosedInclusiveAt: new Date(),
      resolvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(
      eq(derivOrderIntentsTable.intentId, args.intentId),
      isNull(derivOrderIntentsTable.venueContractRef),
    ))
    .returning();
  return rows[0] ?? null;
}

/**
 * Intents that may still have an order standing at the venue.
 *
 * WRITTEN and UNRECORDED only. NOT_ATTEMPTED never reached the wire and
 * REFUSED_PRE_TRANSMISSION is proven not to have — neither can be an
 * outstanding position, and sweeping them would waste venue reads on orders
 * that provably do not exist.
 */
export async function listUnresolved(userId: number, limit = 100): Promise<DerivOrderIntentRow[]> {
  return db.select().from(derivOrderIntentsTable)
    .where(and(
      eq(derivOrderIntentsTable.userId, userId),
      isNull(derivOrderIntentsTable.resolvedAt),
      sql`${derivOrderIntentsTable.writeDisposition} in ('WRITTEN','UNRECORDED')`,
    ))
    .limit(limit);
}

/**
 * Does this user have an outstanding intent that must be resolved before
 * another order may be placed?
 *
 * The owner's Tier 1 rule: if an execution state becomes UNKNOWN/UNRESOLVED,
 * STOP new orders until it is resolved. This is the query that enforces it.
 */
export async function hasUnresolvedIntent(userId: number): Promise<boolean> {
  const rows = await listUnresolved(userId, 1);
  return rows.length > 0;
}

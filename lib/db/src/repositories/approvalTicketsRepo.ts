// Phase 6 — approval ticket persistence.
//
// The pure lifecycle law lives in
// @workspace/domain/safety-contracts/approvalTicket. This module is only the
// persistence side, and it exists to make ONE guarantee the pure layer cannot:
//
//     one approval produces AT MOST one venue order,
//     under concurrent requests, double-clicks and retries.
//
// A process-local mutex cannot provide that — the API runs more than one
// process, and a mutex is invisible across them. The guarantee comes from a
// compare-and-set UPDATE whose WHERE clause names the state it expects, so the
// database decides the winner. This mirrors claimLiveCommandForDispatch, which
// already does exactly this for live commands; copying an established pattern
// beats inventing a second one.

import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { db } from "../index";
import { approvalTicketsTable } from "../schema/phase6GuidedExecution";

export type ApprovalTicketRow = typeof approvalTicketsTable.$inferSelect;
type TicketPatch = Partial<typeof approvalTicketsTable.$inferInsert>;

export async function findTicketById(ticketId: string): Promise<ApprovalTicketRow | null> {
  const rows = await db.select().from(approvalTicketsTable)
    .where(eq(approvalTicketsTable.ticketId, ticketId)).limit(1);
  return rows[0] ?? null;
}

/**
 * Read a ticket that MUST belong to this user.
 *
 * Ownership is enforced in the WHERE clause, not by fetching and comparing in
 * application code. There is no row-level security in this database, so a
 * forgotten comparison is the whole defence gone — putting it in the query
 * means a caller cannot forget it.
 */
export async function findOwnedTicket(
  ticketId: string,
  userId: number,
): Promise<ApprovalTicketRow | null> {
  const rows = await db.select().from(approvalTicketsTable)
    .where(and(
      eq(approvalTicketsTable.ticketId, ticketId),
      eq(approvalTicketsTable.userId, userId),
    )).limit(1);
  return rows[0] ?? null;
}

export async function listInboxForUser(userId: number): Promise<ApprovalTicketRow[]> {
  return db.select().from(approvalTicketsTable)
    .where(eq(approvalTicketsTable.userId, userId))
    .orderBy(sql`created_at desc`);
}

/**
 * Record an explicit human approval.
 *
 * CAS on state='PENDING' AND user_id, so:
 *   - a second approval of the same ticket loses and returns null;
 *   - another user's approval matches zero rows — it cannot approve a ticket
 *     that is not theirs, even if they know the id;
 *   - a ticket already rejected, expired or dispatching cannot be approved.
 *
 * `expiresAt` is re-checked here against the DATABASE clock rather than the
 * caller's: an approval arriving after expiry must lose even if the caller's
 * clock disagrees.
 */
export async function approveTicket(args: {
  ticketId: string;
  userId: number;
  approvedByUserId: number;
  approvedFingerprint: string;
}): Promise<ApprovalTicketRow | null> {
  // The approver must BE the owner. Checked here as well as in the pure layer:
  // this is the last point before the row says "a human said yes".
  if (args.approvedByUserId !== args.userId) return null;

  const rows = await db.update(approvalTicketsTable)
    .set({
      state: "APPROVED",
      approvedByUserId: args.approvedByUserId,
      approvedFingerprint: args.approvedFingerprint,
      approvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(
      eq(approvalTicketsTable.ticketId, args.ticketId),
      eq(approvalTicketsTable.userId, args.userId),
      eq(approvalTicketsTable.state, "PENDING"),
      sql`${approvalTicketsTable.expiresAt} > now()`,
    ))
    .returning();
  return rows[0] ?? null;
}

export async function rejectTicket(args: {
  ticketId: string;
  userId: number;
  rejectedByUserId: number;
  reason: string;
  source: "USER" | "SYSTEM_PRE_TRANSMISSION" | "SYSTEM_GATE";
}): Promise<ApprovalTicketRow | null> {
  // Rejectable from PENDING or APPROVED — a user may withdraw consent right up
  // until a dispatch claim is won. Once DISPATCHING, an order may exist and
  // rejection would be a claim about the venue this layer cannot make.
  const rows = await db.update(approvalTicketsTable)
    .set({
      state: "REJECTED",
      rejectedByUserId: args.rejectedByUserId,
      rejectionReason: args.reason.slice(0, 400),
      rejectionSource: args.source,
      rejectedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(
      eq(approvalTicketsTable.ticketId, args.ticketId),
      eq(approvalTicketsTable.userId, args.userId),
      sql`${approvalTicketsTable.state} in ('PENDING','APPROVED')`,
    ))
    .returning();
  return rows[0] ?? null;
}

export const TICKET_DISPATCH_RACE_LOST = "TICKET_DISPATCH_RACE_LOST" as const;

/**
 * THE ATOMIC DISPATCH CLAIM.
 *
 * Of N concurrent callers for the same approved ticket, exactly one UPDATE can
 * match a row: the first flips state to DISPATCHING, and every subsequent
 * attempt finds state='APPROVED' false and matches nothing. Losers get null and
 * MUST refuse — never fall through to the adapter.
 *
 * `dispatch_claimed_at IS NULL` is belt to that braces. If a future edit ever
 * widened the state predicate, this would still stop a second claim on a ticket
 * that has already been claimed once.
 *
 * Expiry is enforced with the DATABASE clock. A caller whose own clock is
 * behind must not be able to dispatch a ticket that expired.
 */
export async function claimTicketForDispatch(args: {
  ticketId: string;
  userId: number;
  liveCommandId: string;
}): Promise<ApprovalTicketRow | null> {
  const rows = await db.update(approvalTicketsTable)
    .set({
      state: "DISPATCHING",
      dispatchClaimedAt: new Date(),
      liveCommandId: args.liveCommandId,
      updatedAt: new Date(),
    })
    .where(and(
      eq(approvalTicketsTable.ticketId, args.ticketId),
      eq(approvalTicketsTable.userId, args.userId),
      eq(approvalTicketsTable.state, "APPROVED"),
      isNull(approvalTicketsTable.dispatchClaimedAt),
      sql`${approvalTicketsTable.expiresAt} > now()`,
    ))
    .returning();
  return rows[0] ?? null;
}

/**
 * Record the venue outcome for a claimed ticket.
 *
 * Only from DISPATCHING, and only to a state the certified model permits.
 * UNRESOLVED is NOT terminal and deliberately does not clear
 * dispatch_claimed_at: the claim is what stops a retry, and an order that may
 * exist must never become re-dispatchable.
 */
export async function settleDispatchedTicket(args: {
  ticketId: string;
  outcome: "EXECUTED" | "UNRESOLVED" | "REJECTED";
  venueContractRef?: string | null;
  rejectionReason?: string;
  rejectionSource?: "USER" | "SYSTEM_PRE_TRANSMISSION" | "SYSTEM_GATE";
}): Promise<ApprovalTicketRow | null> {
  const patch: TicketPatch = { state: args.outcome, updatedAt: new Date() };
  if (args.outcome === "EXECUTED") {
    // An EXECUTED ticket must carry the venue's own reference. Recording
    // execution without one would be a claim with no evidence behind it.
    if (typeof args.venueContractRef !== "string" || args.venueContractRef.trim() === "") return null;
    patch.venueContractRef = args.venueContractRef;
  }
  if (args.outcome === "REJECTED") {
    patch.rejectedAt = new Date();
    patch.rejectionReason = (args.rejectionReason ?? "").slice(0, 400);
    patch.rejectionSource = args.rejectionSource ?? "SYSTEM_GATE";
  }
  const rows = await db.update(approvalTicketsTable)
    .set(patch)
    .where(and(
      eq(approvalTicketsTable.ticketId, args.ticketId),
      eq(approvalTicketsTable.state, "DISPATCHING"),
    ))
    .returning();
  return rows[0] ?? null;
}

/**
 * Expire tickets past their deadline.
 *
 * Deliberately restricted to PENDING and APPROVED — states in which nothing was
 * ever sent to a venue, so expiry is a pure scheduling fact.
 *
 * DISPATCHING and UNRESOLVED are EXCLUDED, and that exclusion is the whole
 * point: for those an order may exist at the venue, and time passing proves
 * nothing about whether it does. Sweeping them would convert "we do not know"
 * into "it did not happen" on a timer — exactly the falsely-certain transition
 * the owner forbade. They are resolved only by reconciliation against venue
 * evidence.
 */
export async function expireStaleTickets(limit = 200): Promise<ApprovalTicketRow[]> {
  return db.update(approvalTicketsTable)
    .set({ state: "EXPIRED", updatedAt: new Date() })
    .where(and(
      sql`${approvalTicketsTable.state} in ('PENDING','APPROVED')`,
      lt(approvalTicketsTable.expiresAt, sql`now()`),
      sql`${approvalTicketsTable.ticketId} in (
        select ticket_id from approval_tickets
        where state in ('PENDING','APPROVED') and expires_at < now()
        limit ${limit}
      )`,
    ))
    .returning();
}

export async function createTicket(
  values: typeof approvalTicketsTable.$inferInsert,
): Promise<ApprovalTicketRow> {
  const rows = await db.insert(approvalTicketsTable).values(values).returning();
  const row = rows[0];
  if (!row) throw new Error("APPROVAL_TICKET_INSERT_RETURNED_NO_ROW");
  return row;
}

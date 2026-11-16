// Task #203 — Request-to-Join Onboarding repository.
// Pure data access. No HTTP. Submission NEVER creates an account and NEVER
// bypasses the invite gate. Approval issues an invite via the EXISTING
// beta-invite path (createInvite — cohort cap + one-time code + audit live
// there and are not re-implemented here). Over-cap submissions are still
// accepted + queued (waitlist); the cap is only enforced at Approve time by
// createInvite.

import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../index";
import { joinRequestsTable, type JoinRequestRow } from "../schema/joinRequests";

export type JoinRequestStatus = "PENDING" | "APPROVED" | "DECLINED";

function normalizeEmail(email: string): string {
  return (email ?? "").trim().toLowerCase();
}

export type CreateRequestResult =
  | { ok: true; request: JoinRequestRow; created: boolean };

/**
 * Create a join request, deduping by email while a request is still PENDING.
 * Returns the existing PENDING row (created=false) on a duplicate so the
 * public endpoint can ALWAYS return a neutral confirmation — it must never
 * reveal whether the email was new, already pending, already invited, or
 * already a user (no enumeration).
 */
export async function createRequest(params: {
  email: string;
  name?: string | null;
  note?: string | null;
  source?: string;
}): Promise<CreateRequestResult> {
  const email = normalizeEmail(params.email);
  const name = params.name ? String(params.name).trim().slice(0, 200) : null;
  const note = params.note ? String(params.note).trim().slice(0, 1000) : null;
  const source = params.source ?? "request_access";

  // Insert; the partial unique index (email WHERE status='PENDING') makes a
  // concurrent / repeat submission a no-op. ON CONFLICT DO NOTHING then a
  // lookup tells us whether we created a fresh row.
  const inserted = await db
    .insert(joinRequestsTable)
    .values({ email, name, note, source })
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) return { ok: true, request: inserted[0], created: true };

  const existing = await db
    .select()
    .from(joinRequestsTable)
    .where(and(eq(joinRequestsTable.email, email), eq(joinRequestsTable.status, "PENDING")))
    .limit(1);
  if (existing[0]) return { ok: true, request: existing[0], created: false };

  // Edge case: a non-PENDING row exists for this email and there is no PENDING
  // row, but the insert still conflicted on something — fall back to a plain
  // insert so a previously-declined prospect can re-apply.
  const retry = await db.insert(joinRequestsTable).values({ email, name, note, source }).returning();
  return { ok: true, request: retry[0]!, created: true };
}

export async function listRequests(status?: JoinRequestStatus): Promise<JoinRequestRow[]> {
  const q = db.select().from(joinRequestsTable);
  const rows = status
    ? await q.where(eq(joinRequestsTable.status, status)).orderBy(desc(joinRequestsTable.createdAt))
    : await q.orderBy(desc(joinRequestsTable.createdAt));
  return rows;
}

export async function countByStatus(): Promise<Record<string, number>> {
  const rows = await db.execute(sql`
    SELECT status, COUNT(*)::int AS c FROM join_requests GROUP BY status
  `);
  const r = (rows as unknown as { rows?: Array<{ status: string; c: number }> }).rows
    ?? (rows as unknown as Array<{ status: string; c: number }>);
  const out: Record<string, number> = {};
  for (const row of r ?? []) out[row.status] = Number(row.c);
  return out;
}

export async function getById(id: number): Promise<JoinRequestRow | null> {
  const rows = await db.select().from(joinRequestsTable).where(eq(joinRequestsTable.id, id)).limit(1);
  return rows[0] ?? null;
}

/**
 * Mark a PENDING request APPROVED and link the issued invite. CAS on
 * status='PENDING' so a double-approve cannot issue two invites. The caller
 * is responsible for actually creating the invite (via the existing
 * betaInvites.createInvite) and passing its id here.
 */
export async function markApproved(params: {
  id: number;
  decidedByUserId: number;
  inviteId: number;
}): Promise<JoinRequestRow | null> {
  const rows = await db
    .update(joinRequestsTable)
    .set({
      status: "APPROVED",
      inviteId: params.inviteId,
      decidedByUserId: params.decidedByUserId,
      decidedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(joinRequestsTable.id, params.id), eq(joinRequestsTable.status, "PENDING")))
    .returning();
  return rows[0] ?? null;
}

/** Mark a PENDING request DECLINED with a required reason. CAS on PENDING. */
export async function markDeclined(params: {
  id: number;
  decidedByUserId: number;
  reason: string;
}): Promise<JoinRequestRow | null> {
  const rows = await db
    .update(joinRequestsTable)
    .set({
      status: "DECLINED",
      declineReason: params.reason.trim().slice(0, 1000),
      decidedByUserId: params.decidedByUserId,
      decidedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(joinRequestsTable.id, params.id), eq(joinRequestsTable.status, "PENDING")))
    .returning();
  return rows[0] ?? null;
}

/** Admin-facing projection. No secret surface exists on this table, but keep
 *  a single shaping function so future columns can't leak by accident. */
export function toPublicJoinRequest(r: JoinRequestRow): Record<string, unknown> {
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    note: r.note,
    status: r.status,
    source: r.source,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    decidedByUserId: r.decidedByUserId,
    decidedAt: r.decidedAt,
    declineReason: r.declineReason,
    inviteId: r.inviteId,
  };
}

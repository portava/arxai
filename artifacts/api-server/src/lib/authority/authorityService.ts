// Capability #37 — authority ledger reads/writes over authority_grants.
//
// Thin IO wrapper around the pure contract in
// @workspace/domain/safety-contracts/authorityGrants. Two honesty rules:
//   * a failed ledger READ during an INCREASE check fails CLOSED with a typed
//     reason (an unreadable permission is not a permission), and
//   * a failed ledger read during the expiry SWEEP fails INERT (a DB blip must
//     never mass-demote missions) — reducing on bad evidence would be acting
//     on fabricated state, exactly what this repo forbids.

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, authorityGrantsTable, type AuthorityGrantRow } from "@workspace/db";
import {
  resolveAuthorityCeiling,
  validateGrantRequest,
  type AuthorityCeiling,
  type AuthorityKind,
  type AuthorityScope,
} from "@workspace/domain/safety-contracts/authorityGrants";

export type CeilingRead =
  | { ok: true; ceiling: AuthorityCeiling }
  | { ok: false; reason: "AUTHORITY_LEDGER_UNREADABLE"; detail: string };

/** Read all of a user's grants for one kind and resolve the ceiling for a
 *  specific scope. Fail-closed contract: callers gating an INCREASE must treat
 *  `ok:false` as "no authority". */
export async function readAuthorityCeiling(args: {
  userId: number;
  kind: AuthorityKind;
  scopeType?: Exclude<AuthorityScope, "ACCOUNT">;
  scopeRef?: string | null;
  now?: Date;
}): Promise<CeilingRead> {
  const now = args.now ?? new Date();
  try {
    const rows = await db
      .select()
      .from(authorityGrantsTable)
      .where(and(eq(authorityGrantsTable.userId, args.userId), eq(authorityGrantsTable.kind, args.kind)));
    const ceiling = resolveAuthorityCeiling({
      kind: args.kind,
      scopeType: args.scopeType,
      scopeRef: args.scopeRef ?? null,
      now,
      grants: rows,
    });
    return { ok: true, ceiling };
  } catch (err) {
    return {
      ok: false,
      reason: "AUTHORITY_LEDGER_UNREADABLE",
      detail: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
    };
  }
}

export type CreateGrantResult =
  | { ok: true; grant: AuthorityGrantRow }
  | { ok: false; reason: string };

/** Owner-press grant creation. The route has already authenticated the press;
 *  this validates the request against the pure contract and persists it. */
export async function createAuthorityGrant(args: {
  userId: number;
  grantedByUserId: number;
  kind: unknown;
  scopeType: unknown;
  scopeRef: unknown;
  maxLevel: unknown;
  expiresAt: Date;
  reason?: string | null;
  now?: Date;
}): Promise<CreateGrantResult> {
  const now = args.now ?? new Date();
  const v = validateGrantRequest({
    kind: args.kind,
    scopeType: args.scopeType,
    scopeRef: args.scopeRef,
    maxLevel: args.maxLevel,
    expiresAt: args.expiresAt,
    now,
  });
  if (!v.ok) return { ok: false, reason: v.reason };
  const inserted = await db
    .insert(authorityGrantsTable)
    .values({
      publicId: `ag_${randomUUID()}`,
      userId: args.userId,
      kind: args.kind as string,
      scopeType: args.scopeType as string,
      scopeRef: args.scopeType === "ACCOUNT" ? null : String(args.scopeRef),
      maxLevel: args.maxLevel as number,
      reason: args.reason ?? null,
      grantedByUserId: args.grantedByUserId,
      grantedAt: now,
      expiresAt: args.expiresAt,
    })
    .returning();
  return { ok: true, grant: inserted[0]! };
}

export type RevokeGrantResult =
  | { ok: true; grant: AuthorityGrantRow }
  | { ok: false; reason: "NOT_FOUND" | "ALREADY_REVOKED" };

/** Instant reduction: revocation takes effect on the next resolution. */
export async function revokeAuthorityGrant(args: {
  userId: number;
  publicId: string;
  revokedByUserId: number;
  now?: Date;
}): Promise<RevokeGrantResult> {
  const now = args.now ?? new Date();
  const rows = await db
    .select()
    .from(authorityGrantsTable)
    .where(and(eq(authorityGrantsTable.userId, args.userId), eq(authorityGrantsTable.publicId, args.publicId)))
    .limit(1);
  const row = rows[0];
  if (!row) return { ok: false, reason: "NOT_FOUND" };
  if (row.revokedAt != null) return { ok: false, reason: "ALREADY_REVOKED" };
  const updated = await db
    .update(authorityGrantsTable)
    .set({ revokedAt: now, revokedByUserId: args.revokedByUserId })
    .where(and(eq(authorityGrantsTable.id, row.id), eq(authorityGrantsTable.userId, args.userId)))
    .returning();
  return { ok: true, grant: updated[0]! };
}

/** All grants for a user (newest first), for the /me/authority read surface. */
export async function listAuthorityGrants(userId: number): Promise<AuthorityGrantRow[]> {
  const rows = await db
    .select()
    .from(authorityGrantsTable)
    .where(eq(authorityGrantsTable.userId, userId));
  return rows.sort((a, b) => b.grantedAt.getTime() - a.grantedAt.getTime());
}

// Task #202 — Self-serve forgot/reset password flow repository.
// Pure data access. No HTTP. The raw token is generated here and returned to the
// caller exactly once (for the reset link); only its sha256 hash is persisted.
// Tokens are single-use (consumeToken CAS on used_at IS NULL) and expiring; a
// newly-issued token invalidates the user's older unused tokens.

import { randomBytes, createHash } from "node:crypto";
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { db } from "../index";
import { passwordResetTokensTable, type PasswordResetTokenRow } from "../schema/passwordResetTokens";

// Reset tokens are short-lived by design (account-recovery window).
const TTL_MS = 45 * 60 * 1000; // 45 minutes

export function hashResetToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export interface CreatedResetToken {
  rawToken: string;
  expiresAt: Date;
}

/**
 * Issue a fresh single-use reset token for a user. Any of the user's prior
 * unused tokens are invalidated first (marked used) so only the newest link
 * works — satisfies "invalidated when a newer one is issued". Returns the raw
 * token (caller embeds it in the reset link); only the hash is stored.
 */
export async function createToken(params: {
  userId: number;
  ipAddress?: string | null;
}): Promise<CreatedResetToken> {
  const now = new Date();
  // Invalidate older unused tokens for this user (newer-invalidates-older).
  await db
    .update(passwordResetTokensTable)
    .set({ usedAt: now })
    .where(and(eq(passwordResetTokensTable.userId, params.userId), isNull(passwordResetTokensTable.usedAt)));

  const rawToken = randomBytes(32).toString("base64url");
  const tokenHash = hashResetToken(rawToken);
  const expiresAt = new Date(now.getTime() + TTL_MS);
  await db.insert(passwordResetTokensTable).values({
    userId: params.userId,
    tokenHash,
    expiresAt,
    ipAddress: params.ipAddress ?? null,
  });
  return { rawToken, expiresAt };
}

/**
 * Constant-work decoy for forgot-password requests whose email does NOT map to
 * an account. Mirrors createToken's crypto (random + sha256) and its two DB
 * roundtrips (update + insert) so the response latency of a non-existent email
 * is indistinguishable from a real one — closing a timing-based account
 * enumeration side-channel. Nothing is persisted; no email is sent.
 */
export async function dummyWork(): Promise<void> {
  const rawToken = randomBytes(32).toString("base64url");
  hashResetToken(rawToken);
  await db.execute(sql`SELECT 1`);
  await db.execute(sql`SELECT 1`);
}

export type ConsumeResult =
  | { ok: true; userId: number }
  | { ok: false; reason: "NOT_FOUND" | "EXPIRED" | "ALREADY_USED" };

/**
 * Validate and atomically consume a reset token. Single-use is enforced by a
 * compare-and-set: the UPDATE only matches a row whose used_at IS NULL, so two
 * concurrent resets cannot both succeed. Returns the owning userId on success.
 */
export async function consumeToken(rawToken: string): Promise<ConsumeResult> {
  if (!rawToken) return { ok: false, reason: "NOT_FOUND" };
  const tokenHash = hashResetToken(rawToken);
  const rows = await db
    .select()
    .from(passwordResetTokensTable)
    .where(eq(passwordResetTokensTable.tokenHash, tokenHash))
    .limit(1);
  const row = rows[0];
  if (!row) return { ok: false, reason: "NOT_FOUND" };
  if (row.usedAt) return { ok: false, reason: "ALREADY_USED" };
  if (row.expiresAt.getTime() <= Date.now()) return { ok: false, reason: "EXPIRED" };

  // CAS: only consume if still unused. rowcount 0 → lost a race / already used.
  const updated = await db
    .update(passwordResetTokensTable)
    .set({ usedAt: new Date() })
    .where(and(eq(passwordResetTokensTable.id, row.id), isNull(passwordResetTokensTable.usedAt)))
    .returning({ id: passwordResetTokensTable.id });
  if (updated.length === 0) return { ok: false, reason: "ALREADY_USED" };
  return { ok: true, userId: row.userId };
}

/** Housekeeping — delete tokens that expired more than a day ago. */
export async function purgeExpired(): Promise<number> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const r = await db
    .delete(passwordResetTokensTable)
    .where(lt(passwordResetTokensTable.expiresAt, cutoff))
    .returning({ id: passwordResetTokensTable.id });
  return r.length;
}

/** Count active (unused, unexpired) tokens for a user — test/diagnostic only. */
export async function countActiveForUser(userId: number): Promise<number> {
  const rows = await db.execute(sql`
    SELECT COUNT(*)::int AS c FROM password_reset_tokens
    WHERE user_id = ${userId} AND used_at IS NULL AND expires_at > NOW()
  `);
  const r = (rows as unknown as { rows?: Array<{ c: number }> }).rows
    ?? (rows as unknown as Array<{ c: number }>);
  return Number(r?.[0]?.c ?? 0);
}

export type { PasswordResetTokenRow };

// Per-user login sessions. The raw token is a 32-byte URL-safe random string
// stored only in the httpOnly `arx_user_session` cookie. We persist sha256
// of the token so a DB leak does not yield usable session credentials.

import { randomBytes, createHash } from "node:crypto";
import { eq, lt } from "drizzle-orm";
import { db, authUserSessionsTable, usersTable, type User } from "@workspace/db";

export const USER_SESSION_COOKIE = "arx_user_session";
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export interface CreatedSession {
  rawToken: string;
  expiresAt: Date;
}

export async function createUserSession(opts: {
  userId: number;
  ipAddress?: string | null;
  userAgent?: string | null;
}): Promise<CreatedSession> {
  const rawToken = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + TTL_MS);
  await db.insert(authUserSessionsTable).values({
    userId: opts.userId,
    tokenHash,
    expiresAt,
    ipAddress: opts.ipAddress ?? null,
    userAgent: opts.userAgent ?? null,
  });
  return { rawToken, expiresAt };
}

export async function findUserBySessionToken(rawToken: string): Promise<User | null> {
  if (!rawToken) return null;
  const tokenHash = hashToken(rawToken);
  const rows = await db
    .select({ user: usersTable, session: authUserSessionsTable })
    .from(authUserSessionsTable)
    .innerJoin(usersTable, eq(usersTable.id, authUserSessionsTable.userId))
    .where(eq(authUserSessionsTable.tokenHash, tokenHash))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (row.session.expiresAt.getTime() <= Date.now()) {
    // Lazily clean expired session.
    await db
      .delete(authUserSessionsTable)
      .where(eq(authUserSessionsTable.tokenHash, tokenHash))
      .catch(() => {});
    return null;
  }
  // Touch lastSeenAt without blocking the request.
  void db
    .update(authUserSessionsTable)
    .set({ lastSeenAt: new Date() })
    .where(eq(authUserSessionsTable.tokenHash, tokenHash))
    .catch(() => {});
  return row.user;
}

export async function destroyUserSession(rawToken: string): Promise<void> {
  if (!rawToken) return;
  const tokenHash = hashToken(rawToken);
  await db
    .delete(authUserSessionsTable)
    .where(eq(authUserSessionsTable.tokenHash, tokenHash))
    .catch(() => {});
}

// Invalidate every active session for a user — used after a password reset so
// any stolen/old session cookie (on any device) stops working immediately.
export async function destroyAllUserSessions(userId: number): Promise<number> {
  const r = await db
    .delete(authUserSessionsTable)
    .where(eq(authUserSessionsTable.userId, userId))
    .returning({ id: authUserSessionsTable.id });
  return r.length;
}

export async function purgeExpiredSessions(): Promise<number> {
  const r = await db
    .delete(authUserSessionsTable)
    .where(lt(authUserSessionsTable.expiresAt, new Date()))
    .returning({ id: authUserSessionsTable.id });
  return r.length;
}

// Task #210 — Durable password-reset rate limiting repository.
// Pure data access. No HTTP. Backs the forgot-password throttle with shared,
// durable storage (a DB table) instead of a process-local in-memory Map. This
// makes the limit survive API-server restarts and stay consistent across
// multiple server instances.
//
// Sliding-window semantics (preserved from the original in-memory throttle):
// at most FORGOT_MAX attempts per throttle key within FORGOT_WINDOW_MS. Each
// call records one attempt and reports whether the caller is now over the cap.

import { sql } from "drizzle-orm";
import { db } from "../index";
import { passwordResetThrottleTable, type PasswordResetThrottleRow } from "../schema/passwordResetThrottle";

// Mirrors the original in-memory limits: 5 attempts / 15 minutes per ip+email.
export const FORGOT_MAX = 5;
export const FORGOT_WINDOW_MS = 15 * 60 * 1000;

// Probability of an opportunistic housekeeping purge per call. Keeps the table
// bounded without a dedicated scheduler (mirrors the size-based cleanup the old
// in-memory Map performed). Fire-and-forget; failures never affect throttling.
const PURGE_PROBABILITY = 0.02;

function readCount(result: unknown): number {
  const r =
    (result as { rows?: Array<{ c: number }> }).rows ??
    (result as Array<{ c: number }>);
  return Number(r?.[0]?.c ?? 0);
}

/**
 * Record a forgot-password attempt for `key` and return whether the caller is
 * now throttled (has exceeded FORGOT_MAX within the window).
 *
 * Atomic and race-safe: the INSERT always lands; the COUNT reads prior rows in
 * the window from the statement's snapshot (the just-inserted row is not yet
 * visible to the same statement), so total = prior + 1. This matches the old
 * "push now, then test length > MAX" sliding-window semantics exactly, in a
 * single round-trip, even under concurrent requests across instances.
 */
export async function recordAttemptAndCheck(key: string): Promise<boolean> {
  const windowSeconds = Math.floor(FORGOT_WINDOW_MS / 1000);
  const result = await db.execute(sql`
    WITH ins AS (
      INSERT INTO password_reset_throttle (throttle_key)
      VALUES (${key})
      RETURNING id
    )
    SELECT COUNT(*)::int AS c
    FROM password_reset_throttle
    WHERE throttle_key = ${key}
      AND created_at > NOW() - (${windowSeconds} * INTERVAL '1 second')
  `);
  const priorInWindow = readCount(result);
  const total = priorInWindow + 1;

  // Opportunistic, best-effort housekeeping so the table stays bounded.
  if (Math.random() < PURGE_PROBABILITY) {
    void purgeExpired().catch(() => {});
  }

  return total > FORGOT_MAX;
}

/**
 * Delete throttle rows older than the window — they can no longer affect any
 * sliding-window count. Housekeeping only.
 */
export async function purgeExpired(): Promise<number> {
  const windowSeconds = Math.floor(FORGOT_WINDOW_MS / 1000);
  const result = await db.execute(sql`
    DELETE FROM password_reset_throttle
    WHERE created_at <= NOW() - (${windowSeconds} * INTERVAL '1 second')
    RETURNING id
  `);
  const rows =
    (result as { rows?: unknown[] }).rows ?? (result as unknown as unknown[]);
  return Array.isArray(rows) ? rows.length : 0;
}

/** Count attempts for a key within the current window — test/diagnostic only. */
export async function countAttemptsInWindow(key: string): Promise<number> {
  const windowSeconds = Math.floor(FORGOT_WINDOW_MS / 1000);
  const result = await db.execute(sql`
    SELECT COUNT(*)::int AS c FROM password_reset_throttle
    WHERE throttle_key = ${key}
      AND created_at > NOW() - (${windowSeconds} * INTERVAL '1 second')
  `);
  return readCount(result);
}

export type { PasswordResetThrottleRow };

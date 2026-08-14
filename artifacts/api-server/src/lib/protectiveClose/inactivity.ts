// Phase 13 — Protective Auto-Close: user activity / inactivity detection.
//
// SAFETY:
//   * Activity is bumped only by authenticated POST /me/activity-ping.
//   * When no row exists OR all heartbeats are NULL, status="UNKNOWN".
//     The decision engine MUST downgrade to ALERT_ONLY on UNKNOWN — it
//     never assumes the user is missing on weak signal.
//   * Inactivity duration is computed against the MOST RECENT of the
//     three heartbeats (app activity, trade interaction, AI interaction).

import { db } from "@workspace/db";
import { userActivityTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

export interface ActivityStatus {
  status: "ACTIVE" | "INACTIVE" | "UNKNOWN";
  lastActiveAt: string | null;
  lastTradeInteractionAt: string | null;
  lastAiInteractionAt: string | null;
  inactiveDurationMs: number | null;
  reason: string;
}

export async function getActivityStatus(userId: number, thresholdMin: number): Promise<ActivityStatus> {
  const [row] = await db.select().from(userActivityTable)
    .where(eq(userActivityTable.userId, userId))
    .limit(1);
  if (!row) {
    return {
      status: "UNKNOWN",
      lastActiveAt: null,
      lastTradeInteractionAt: null,
      lastAiInteractionAt: null,
      inactiveDurationMs: null,
      reason: "no activity heartbeat recorded yet",
    };
  }
  const candidates: Date[] = [];
  if (row.lastActiveAt) candidates.push(row.lastActiveAt);
  if (row.lastTradeInteractionAt) candidates.push(row.lastTradeInteractionAt);
  if (row.lastAiInteractionAt) candidates.push(row.lastAiInteractionAt);
  if (candidates.length === 0) {
    return {
      status: "UNKNOWN",
      lastActiveAt: null,
      lastTradeInteractionAt: null,
      lastAiInteractionAt: null,
      inactiveDurationMs: null,
      reason: "activity row exists but no timestamps set",
    };
  }
  const mostRecent = candidates.reduce((a, b) => (a.getTime() > b.getTime() ? a : b));
  const inactiveMs = Date.now() - mostRecent.getTime();
  const thresholdMs = thresholdMin * 60_000;
  const isInactive = inactiveMs >= thresholdMs;
  return {
    status: isInactive ? "INACTIVE" : "ACTIVE",
    lastActiveAt: row.lastActiveAt?.toISOString() ?? null,
    lastTradeInteractionAt: row.lastTradeInteractionAt?.toISOString() ?? null,
    lastAiInteractionAt: row.lastAiInteractionAt?.toISOString() ?? null,
    inactiveDurationMs: inactiveMs,
    reason: isInactive
      ? `most recent interaction ${Math.round(inactiveMs / 1000)}s ago ≥ threshold ${thresholdMs / 1000}s`
      : `most recent interaction ${Math.round(inactiveMs / 1000)}s ago < threshold ${thresholdMs / 1000}s`,
  };
}

export type PingKind = "app" | "trade" | "ai";

export async function bumpActivity(userId: number, kinds: PingKind[]): Promise<void> {
  const now = new Date();
  const patch: Record<string, Date> = { updatedAt: now };
  if (kinds.includes("app")) patch["lastActiveAt"] = now;
  if (kinds.includes("trade")) patch["lastTradeInteractionAt"] = now;
  if (kinds.includes("ai")) patch["lastAiInteractionAt"] = now;
  await db.insert(userActivityTable).values({
    userId,
    lastActiveAt: kinds.includes("app") ? now : null,
    lastTradeInteractionAt: kinds.includes("trade") ? now : null,
    lastAiInteractionAt: kinds.includes("ai") ? now : null,
    updatedAt: now,
  }).onConflictDoUpdate({ target: userActivityTable.userId, set: patch });
}

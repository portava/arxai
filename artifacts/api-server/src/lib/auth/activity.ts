// Safe, non-sensitive user activity logger. NEVER pass passwords, bridge
// tokens, or full credentials in `metadata`. The caller is responsible for
// keeping payloads small and PII-free.

import { db, userActivityEventsTable } from "@workspace/db";
import { logger } from "../logger.js";

export type UserActivityEventType =
  | "USER_REGISTERED"
  | "USER_LOGGED_IN"
  | "USER_LOGGED_OUT"
  | "TRADING_SESSION_CREATED"
  | "TRADING_SESSION_CLOSED"
  | "MT5_CONNECTION_CREATED"
  | "MT5_HEARTBEAT_RECEIVED"
  | "PAPER_IDEA_CREATED"
  | "AI_ANALYSIS_CREATED"
  | "DEMO_COMMAND_QUEUED"
  | "DEMO_COMMAND_BLOCKED"
  | "SAFETY_GUARD_TRIGGERED";

export async function recordUserActivity(
  userId: number,
  eventType: UserActivityEventType,
  metadata?: Record<string, unknown>,
): Promise<void> {
  try {
    await db.insert(userActivityEventsTable).values({
      userId,
      eventType,
      metadata: metadata ?? null,
    });
  } catch (err) {
    logger.warn({ err, userId, eventType }, "Failed to record user activity event");
  }
}

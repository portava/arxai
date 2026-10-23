// Task #203 — notify admins of a new request-to-join.
// Fan-out the existing per-user notification service to every ADMIN/OWNER.
// Best-effort + fire-and-forget: a notification failure NEVER blocks the
// neutral public confirmation. entityId = the join_request id, so repeated
// emissions for the SAME request collapse via the dedupe key (no spam) while
// distinct requests get distinct notifications.

import { db, usersTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { createNotification } from "../notificationService.js";

export async function listAdminUserIds(): Promise<number[]> {
  const rows = await db
    .select({ id: usersTable.id, role: usersTable.role })
    .from(usersTable)
    .where(sql`UPPER(${usersTable.role}) IN ('ADMIN','OWNER')`);
  return rows.map((r) => r.id);
}

export async function notifyAdminsOfJoinRequest(params: {
  requestId: number;
  email: string;
}): Promise<void> {
  try {
    const adminIds = await listAdminUserIds();
    await Promise.all(
      adminIds.map((adminId) =>
        createNotification(adminId, {
          notificationType: "join_request_received",
          severity: "info",
          source: "system",
          title: "New access request",
          message: `${params.email} requested access to ARX AI.`,
          entityType: "join_request",
          entityId: params.requestId,
          actionLabel: "Review",
          actionTarget: "/admin/beta-control",
        }).catch(() => null),
      ),
    );
  } catch {
    /* best-effort — never block the public confirmation */
  }
}

export function fireNotifyAdminsOfJoinRequest(params: { requestId: number; email: string }): void {
  void notifyAdminsOfJoinRequest(params).catch(() => undefined);
}

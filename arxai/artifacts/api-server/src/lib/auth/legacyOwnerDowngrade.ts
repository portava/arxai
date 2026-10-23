// Legacy-owner → trader downgrade (single-active-role model).
//
// The product-role model gives every account exactly ONE active role. One
// legacy account was historically created as an OWNER but is now meant to be a
// plain trader (USER). This startup step performs that downgrade idempotently
// so the role split is reproducible from code (and on a fresh database), not a
// one-off manual SQL edit that silently disappears on a DB reset.
//
// The target email is supplied via `ARX_LEGACY_OWNER_DEMOTE_EMAIL` (an
// identifier, not a secret) so no personal address is hard-coded in source.
//
// SAFETY:
//   * Mutates ONLY `users.role` (never passwordHash, never sessions).
//   * Live-testing permissions (per-user live arming, master-live approval,
//     funded-pilot cohort membership) are keyed by userId and are
//     role-independent, so they survive the downgrade untouched — a downgraded
//     owner keeps its trader-scoped live-testing approval.
//   * Idempotent: a no-op once the row is already USER.
//   * Runs AFTER owner/admin bootstrap so it has the final word for this
//     specific account even if some other step elevated it.

import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { logger } from "../logger.js";

// Pure decision helper (unit-testable): only an elevated role is downgraded.
export function roleNeedsTraderDowngrade(role: string | null | undefined): boolean {
  return role === "OWNER" || role === "ADMIN";
}

export async function bootstrapLegacyOwnerDowngrade(): Promise<void> {
  const email = process.env["ARX_LEGACY_OWNER_DEMOTE_EMAIL"]?.trim().toLowerCase();
  if (!email) return;

  const existing = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, email))
    .limit(1);

  const row = existing[0];
  if (!row) {
    logger.info({ email }, "Legacy-owner downgrade: no matching user row (skip)");
    return;
  }

  if (!roleNeedsTraderDowngrade(row.role)) {
    // Already a trader (or any non-elevated role) — nothing to do.
    return;
  }

  await db
    .update(usersTable)
    .set({ role: "USER", updatedAt: new Date() })
    .where(eq(usersTable.id, row.id));
  logger.info(
    { email, from: row.role },
    "Legacy-owner downgraded to USER (trader); live-testing permissions preserved",
  );
}

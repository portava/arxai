// Admin account bootstrap.
//
// On startup, if `ARX_ADMIN_EMAIL` is set we ensure a `users` row exists with
// role=ADMIN. If `ARX_ADMIN_INITIAL_PASSWORD` is also set AND that row has no
// passwordHash yet, we set it ONCE so the admin can sign in via the normal
// /api/auth/login flow. This is logged loudly so the operator rotates it.
//
// Mirrors ownerBootstrap exactly, but seeds a dedicated, secrets-only ADMIN
// account independent of the OWNER row. It never overwrites an existing
// passwordHash, never logs the password value, never downgrades an existing
// OWNER, and never auto-grants a session — the admin still signs in normally.

import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { hashPassword } from "./password.js";
import { logger } from "../logger.js";

export async function bootstrapAdminUser(): Promise<void> {
  const email = process.env["ARX_ADMIN_EMAIL"]?.trim().toLowerCase();
  if (!email) return;

  const existing = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, email))
    .limit(1);

  if (existing.length === 0) {
    await db.insert(usersTable).values({
      email,
      name: "Admin",
      role: "ADMIN",
    });
    logger.info({ email }, "Admin user row created (no password yet)");
  } else {
    const row = existing[0]!;
    // Promote to ADMIN only when not already an elevated role. Never downgrade
    // an existing OWNER — owners outrank admins in the security layer.
    if (row.role !== "ADMIN" && row.role !== "OWNER") {
      await db
        .update(usersTable)
        .set({ role: "ADMIN", updatedAt: new Date() })
        .where(eq(usersTable.id, row.id));
      logger.info({ email }, "Admin user role set to ADMIN");
    }
  }

  const initial = process.env["ARX_ADMIN_INITIAL_PASSWORD"];
  if (initial) {
    const row = (
      await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1)
    )[0];
    if (row && !row.passwordHash) {
      try {
        const hash = hashPassword(initial);
        await db
          .update(usersTable)
          .set({ passwordHash: hash, updatedAt: new Date() })
          .where(eq(usersTable.id, row.id));
        logger.warn(
          { email },
          "Admin initial password set from ARX_ADMIN_INITIAL_PASSWORD — please sign in and change it, then unset the env var.",
        );
      } catch (err) {
        logger.error({ err, email }, "Failed to set admin initial password");
      }
    }
  }
}

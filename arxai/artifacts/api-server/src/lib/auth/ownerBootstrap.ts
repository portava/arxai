// Owner backward-compat bootstrap.
//
// On startup, if `ARX_OWNER_EMAIL` is set we ensure a `users` row exists with
// role=ADMIN. If `ARX_OWNER_INITIAL_PASSWORD` is also set AND that row has no
// passwordHash yet, we set it ONCE so the owner can sign in via the normal
// /api/auth/login flow. This is logged loudly so the operator rotates it.
//
// This bootstrap never overwrites an existing passwordHash, never logs the
// password value, and never auto-grants a session — the owner still has to
// sign in normally.

import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { hashPassword } from "./password.js";
import { logger } from "../logger.js";

export async function bootstrapOwnerUser(): Promise<void> {
  const email = process.env["ARX_OWNER_EMAIL"]?.trim().toLowerCase();
  if (!email) return;

  const existing = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, email))
    .limit(1);

  if (existing.length === 0) {
    await db.insert(usersTable).values({
      email,
      name: "Owner",
      role: "ADMIN",
    });
    logger.info({ email }, "Owner user row created (no password yet)");
  } else if (existing[0]!.role !== "ADMIN") {
    await db
      .update(usersTable)
      .set({ role: "ADMIN", updatedAt: new Date() })
      .where(eq(usersTable.id, existing[0]!.id));
    logger.info({ email }, "Owner user role upgraded to ADMIN");
  }

  const initial = process.env["ARX_OWNER_INITIAL_PASSWORD"];
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
          "Owner initial password set from ARX_OWNER_INITIAL_PASSWORD — please sign in and change it, then unset the env var.",
        );
      } catch (err) {
        logger.error({ err, email }, "Failed to set owner initial password");
      }
    }
  }
}

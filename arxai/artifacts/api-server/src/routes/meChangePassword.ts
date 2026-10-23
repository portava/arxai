// Logged-in password change — self-serve, per-user.
// POST /api/me/change-password
//
// Lets an authenticated user change their own password from inside the app
// (distinct from the public /auth/forgot-password + /auth/reset-password token
// flow). Verifies the caller's CURRENT password before accepting a new one.
//
// SAFETY:
//   - requireUser on the route. Only ever mutates the caller's OWN row
//     (scoped by req.authUser.id) — never another user's password.
//   - Current password is re-verified against the stored scrypt hash; a wrong
//     current password is rejected (no enumeration concern — caller is already
//     authenticated as this user).
//   - On success, EVERY existing session for the user is invalidated (all
//     devices), then a fresh session is issued for THIS device so the caller
//     stays signed in here — mirroring the reset-password revocation posture.
//   - Plain-text passwords are never logged or persisted.

import { Router, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { ChangeMyPasswordBody } from "@workspace/api-zod";
import { hashPassword, verifyPassword } from "../lib/auth/password.js";
import { requireUser } from "../lib/auth/middleware.js";
import {
  createUserSession,
  destroyAllUserSessions,
  USER_SESSION_COOKIE,
} from "../lib/auth/userSessions.js";
import { enforceSensitiveAction } from "../lib/security/handshake.js";
import { auditEvent } from "../lib/systemHealth/audit.js";
import { logger } from "../lib/logger.js";

const log = logger.child({ component: "meChangePassword" });
const router = Router();

const IS_PROD = process.env.NODE_ENV === "production";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — matches auth router.

router.post("/me/change-password", requireUser, async (req: Request, res: Response) => {
  const user = req.authUser!;
  const parsed = ChangeMyPasswordBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: "INVALID_INPUT",
      message: "Your current password and a new password (min 8 characters) are required.",
    });
    return;
  }
  const { currentPassword, newPassword } = parsed.data;

  // Re-verify the CURRENT password against the stored hash.
  if (!user.passwordHash || !verifyPassword(currentPassword, user.passwordHash)) {
    res.status(400).json({
      error: "INVALID_CURRENT_PASSWORD",
      message: "Your current password is incorrect.",
    });
    return;
  }

  // Reject a no-op change so the user can't "change" to the same password.
  if (verifyPassword(newPassword, user.passwordHash)) {
    res.status(400).json({
      error: "SAME_PASSWORD",
      message: "Your new password must be different from your current password.",
    });
    return;
  }

  // Hash the new password (throws on < 8 chars — belt-and-braces over the zod min).
  let passwordHash: string;
  try {
    passwordHash = hashPassword(newPassword);
  } catch (err) {
    res.status(400).json({ error: "WEAK_PASSWORD", message: (err as Error).message });
    return;
  }

  // AACI security handshake (advisory-additive). The authenticated user is the
  // principal; a non-admin action never BLOCKs on a degraded posture, it only
  // records + alerts. Reuses the existing RESET_PASSWORD sensitive action.
  const hs = await enforceSensitiveAction("RESET_PASSWORD", {
    userId: user.id,
    authenticated: true,
  });
  if (!hs.ok) {
    res.status(403).json({ error: hs.reasonCode, message: hs.userMessage });
    return;
  }

  try {
    await db.update(usersTable).set({ passwordHash }).where(eq(usersTable.id, user.id));
  } catch (e) {
    log.error({ err: (e as Error).message, userId: user.id }, "change_password_update_failed");
    res.status(500).json({
      error: "CHANGE_PASSWORD_FAILED",
      message: "Could not change your password. Please try again.",
    });
    return;
  }

  // Invalidate every existing session (all devices) so old cookies stop working.
  const invalidated = await destroyAllUserSessions(user.id);

  void auditEvent({
    eventType: "PASSWORD_CHANGED",
    severity: "INFO",
    actor: "USER",
    action: "self-serve change-password",
    sourceService: "auth",
    metadata: { userId: user.id, sessionsInvalidated: invalidated },
    ipAddress: req.ip ?? null,
  }).catch(() => {});

  // Re-issue a fresh session for THIS device so the caller stays signed in here.
  try {
    const session = await createUserSession({
      userId: user.id,
      ipAddress: req.ip ?? null,
      userAgent: req.header("user-agent") ?? null,
    });
    res.cookie(USER_SESSION_COOKIE, session.rawToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: IS_PROD,
      path: "/",
      maxAge: SESSION_TTL_MS,
    });
  } catch (e) {
    // Password is already changed; the only fallout is the caller must sign in
    // again. Surface that honestly instead of failing the whole request.
    log.error({ err: (e as Error).message, userId: user.id }, "change_password_resession_failed");
    res.status(200).json({
      ok: true,
      message: "Your password has been changed. Please sign in again with your new password.",
    });
    return;
  }

  res.status(200).json({ ok: true, message: "Your password has been changed." });
});

export default router;

// POST /api/me/view-mode — record an admin's view-mode change.
//
// Body: { mode: "admin" | "user" }
//
// SAFETY:
// - Requires a logged-in user.
// - Only ADMIN/OWNER users can flip to "user" mode; regular users
//   receive a clean 403 — there is no view-mode toggle for them.
// - Appends a row to `admin_action_audit_log` with action
//   `ADMIN_MODE_ENABLED` or `ADMIN_MODE_DISABLED` so the operator's
//   self-toggle history is recoverable. Never returns tokens, hashes,
//   secrets, or stack traces.
// - The endpoint deliberately does NOT change the DB role and does NOT
//   touch any trading/MT5/kill-switch state.

import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { adminActionAuditLogTable } from "@workspace/db/schema";
import { requireUser } from "../lib/auth/middleware.js";

const router: IRouter = Router();

router.post("/me/view-mode", requireUser, async (req, res) => {
  const u = req.authUser;
  if (!u) { res.status(401).json({ error: "AUTH_REQUIRED", message: "Sign in required." }); return; }

  const body = (req.body ?? {}) as { mode?: unknown };
  const requested = body.mode;
  if (requested !== "admin" && requested !== "user") {
    res.status(400).json({ error: "INVALID_MODE", message: "Mode must be admin or user." });
    return;
  }

  // The middleware downgrades role to "USER" when the header is set.
  // Use the stashed `realRole` for the gate; fall back to role when not set.
  const stashed = (u as { realRole?: string }).realRole;
  const realRole = String(stashed ?? u.role ?? "").toUpperCase();
  const isAdminCapable = realRole === "ADMIN" || realRole === "OWNER";
  if (!isAdminCapable) {
    res.status(403).json({ error: "NOT_ADMIN_CAPABLE", message: "This account has no admin mode." });
    return;
  }

  const action = requested === "admin" ? "ADMIN_MODE_ENABLED" : "ADMIN_MODE_DISABLED";
  const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim()
    || req.socket.remoteAddress
    || null;

  try {
    await db.insert(adminActionAuditLogTable).values({
      adminId: u.id,
      adminRole: realRole,
      action,
      targetUserId: u.id,
      beforeState: { mode: requested === "admin" ? "user" : "admin" },
      afterState: { mode: requested },
      reason: "self-toggle",
      ipAddress: ip,
    });
    req.log?.info({ event: "view_mode_change", adminId: u.id, action }, "view mode change recorded");
  } catch (e) {
    // Non-fatal: audit failure should not block the UX toggle. Server
    // still enforces the mode via the header on every request.
    req.log?.warn({ err: (e as Error).message, adminId: u.id, action }, "view mode audit insert failed");
  }

  res.json({ ok: true, mode: requested });
});

export default router;

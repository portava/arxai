// Effective view-mode middleware.
//
// When an admin-capable user has toggled into "user" view-mode on the
// frontend, every outbound fetch carries `X-Arx-View-Mode: user`. This
// middleware reads that header AFTER `attachAuthUser` has populated
// `req.authUser`, and — when the real role is ADMIN/OWNER — downgrades
// the request's effective role to "USER" for the remainder of the
// request lifecycle.
//
// Effect: every existing `requireAdmin` / role check in the route layer
// naturally returns 403 without needing per-route changes.
//
// Why this is safe to mutate `req.authUser`:
// - `attachAuthUser` assigns `req.authUser` to the *fresh* row returned by
//   `findUserBySessionToken`, which runs a new DB query on every request
//   (no in-memory cache, no shared reference). Mutating `req.authUser.role`
//   therefore only affects THIS request — it never corrupts the persistent
//   `users` row, the `arx_user_session` row, or any other request.
// - The TRUE authority is preserved on `req.authUser.realRole` BEFORE the
//   downgrade, so identity/audit surfaces (`/api/me/view-mode`,
//   `routes/auth.ts`) recover the real role from `realRole` rather than the
//   downgraded `role`. True role and effective view-mode role are distinct.
//
// SAFETY:
// - Only admins (ADMIN/OWNER) can be downgraded. Sending the header on a
//   regular-user session is a no-op (their role was never elevated), so a
//   normal user can never elevate INTO admin via this header.
// - The downgrade is per-request — the next request re-evaluates from the
//   fresh DB role.
// - This middleware does NOT change MT5, kill-switch, or live-trading
//   rules. It only narrows what the role-check layer sees.

import type { Request, Response, NextFunction } from "express";

export const VIEW_MODE_HEADER_LOWER = "x-arx-view-mode";

export function applyEffectiveViewMode(req: Request, _res: Response, next: NextFunction): void {
  try {
    const raw = req.headers[VIEW_MODE_HEADER_LOWER];
    const headerValue = Array.isArray(raw) ? raw[0] : raw;
    // Accept both "user" (frontend toggle) and "user-preview" (operator
    // tooling / sweep harness). Any other value is a no-op so a malformed
    // header never silently changes behaviour.
    if (headerValue !== "user" && headerValue !== "user-preview") return next();

    const r = req as Request & {
      authUser?: { role?: string; realRole?: string };
      securityRole?: string;
      realSecurityRole?: string;
      viewModeDowngradedToUser?: boolean;
    };

    const u = r.authUser;
    if (!u) return next();
    const realRole = String(u.role ?? "").toUpperCase();
    if (realRole !== "ADMIN" && realRole !== "OWNER") return next();

    // Stash real role + flag so audit/logging contexts (and the identity
    // endpoint) can recover the real authority. Then downgrade every role
    // surface a route layer might consult so EVERY `requireAdmin` check
    // naturally returns 403 — no per-route patches needed. `req.authUser`
    // is a per-request DB object (see header note), so this is request-local.
    u.realRole = realRole;
    u.role = "USER";

    if (typeof r.securityRole === "string") {
      r.realSecurityRole = r.securityRole;
      // The security layer's RoleKey enum doesn't include "USER"; "VIEWER"
      // is its lowest-privilege role and is what regular users resolve to.
      r.securityRole = "VIEWER";
    }

    r.viewModeDowngradedToUser = true;
  } catch {
    /* never throw from middleware — fall through on any malformed input */
  }
  next();
}

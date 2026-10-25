// Build NN — Express middleware for permission checks + security event recording.

import type { Request, Response, NextFunction } from "express";
import { checkPermission, normalizeRole, isLiveTradingAction } from "./permissions.js";
import { recordSecurityEvent, recordAccessLog, repeatedDeniedCount } from "./events.js";
import { getSessionFromReq, dbRoleFor, IS_PROD, DEV_ROLE_CHANNELS } from "./session.js";
import type { RoleKey } from "./seed.js";

declare global {
  namespace Express {
    interface Request {
      securityRole?: RoleKey;
    }
  }
}

// Trusted server-side role resolution — one role model.
//
// SECURITY: the role is the signed-in user's users.role, read on every
// request (getSessionFromReq), then mapped onto the security-permission
// RoleKey set via dbRoleFor(). The `hr_session` cookie is only a mirror and
// can never raise or outlive that role.
//
// Production: nothing else is accepted — not the `x-security-role` header,
// not a dev-owner-login cookie, not an implicit owner, whatever
// ALLOW_DEV_AUTH says. No signed-in user = VIEWER.
//
// Dev/test (NODE_ENV !== "production"): when no user is signed in, the QA
// harness channels (header, dev-owner-login cookie, implicit owner) still
// apply. This is the *only* place they live — auditable single-point gate.
export function readRoleFromRequest(req: Request): RoleKey {
  const session = getSessionFromReq(req);
  return normalizeRole(dbRoleFor(session.role));
}

// The one ADMIN/OWNER route gate for routers that read the role from the
// signed session. Routers used to carry their own identical copy of this.
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const role = readRoleFromRequest(req);
  if (role !== "ADMIN" && role !== "OWNER") {
    res.status(403).json({ error: "Forbidden", requiredRole: "ADMIN" });
    return;
  }
  next();
}

// Exposed for tests + report. Reflects the runtime authority surface.
export function describeRoleAuthority(): {
  source: "signed_in_user_role";
  productionHeaderAccepted: false;
  devHeaderFallbackActive: boolean;
  isProduction: boolean;
} {
  return {
    source: "signed_in_user_role",
    productionHeaderAccepted: false,
    devHeaderFallbackActive: DEV_ROLE_CHANNELS,
    isProduction: IS_PROD,
  };
}

export function attachSecurityContext(req: Request, _res: Response, next: NextFunction): void {
  req.securityRole = readRoleFromRequest(req);
  next();
}

export function requirePermission(permissionKey: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const role = readRoleFromRequest(req);
    const decision = await checkPermission(role, permissionKey);

    if (!decision.allowed) {
      const severity: "WARNING" | "CRITICAL" = decision.forbidden ? "CRITICAL" : "WARNING";
      const evt = await recordSecurityEvent({
        eventType: decision.forbidden ? "FORBIDDEN_ACTION_ATTEMPTED" : "PERMISSION_DENIED",
        severity, status: "DENIED", actorRole: role, permissionKey,
        route: req.originalUrl, method: req.method,
        ipAddress: req.ip ?? null, userAgent: req.header("user-agent") ?? null,
        message: decision.reason,
      });
      await recordAccessLog({
        requestId: req.id ? String(req.id) : null, role, route: req.originalUrl, method: req.method,
        statusCode: 403, permissionRequired: permissionKey, allowed: false, reason: decision.reason,
        metadata: { securityEventId: evt.securityEventId, forbidden: decision.forbidden },
      });
      const repeats = await repeatedDeniedCount(role, req.originalUrl, 50);
      if (repeats >= 3) {
        await recordSecurityEvent({
          eventType: "REPEATED_DENIED_REQUESTS", severity: "WARNING", status: "TRIGGERED",
          actorRole: role, route: req.originalUrl, method: req.method,
          message: `Role ${role} denied ${repeats}× on ${req.originalUrl}`,
          metadata: { repeats },
        });
      }
      res.status(403).json({
        system: "security", liveTradingStatus: "DISABLED", mode: "PAPER_ONLY",
        result: {
          status: "REJECTED", severity, role, permissionKey, reason: decision.reason,
          forbidden: decision.forbidden, securityEventId: evt.securityEventId,
        },
      });
      return;
    }

    await recordAccessLog({
      requestId: req.id ? String(req.id) : null, role, route: req.originalUrl, method: req.method,
      statusCode: 200, permissionRequired: permissionKey, allowed: true, reason: decision.reason,
    });
    req.securityRole = role;
    next();
  };
}

export function forbidLiveTradingAction(action: string): { allowed: boolean; reason: string } {
  if (isLiveTradingAction(action)) {
    return { allowed: false, reason: "FORBIDDEN — live trading is permanently disabled by Build NN" };
  }
  return { allowed: true, reason: "OK" };
}

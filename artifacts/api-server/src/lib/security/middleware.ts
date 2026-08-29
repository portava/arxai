// Build NN — Express middleware for permission checks + security event recording.

import type { Request, Response, NextFunction } from "express";
import { checkPermission, normalizeRole, isLiveTradingAction } from "./permissions.js";
import { recordSecurityEvent, recordAccessLog, repeatedDeniedCount } from "./events.js";
import { getSessionFromReq, dbRoleFor, IS_PROD, ALLOW_DEV_AUTH } from "./session.js";
import type { RoleKey } from "./seed.js";

declare global {
  namespace Express {
    interface Request {
      securityRole?: RoleKey;
    }
  }
}

// Phase 28-SEC — Trusted server-side role resolution.
//
// SECURITY: role authority is derived from the HMAC-signed `hr_session`
// cookie via getSessionFromReq(), then mapped onto the security-permission
// RoleKey set via dbRoleFor().
//
// Production behavior (NODE_ENV === "production" AND ALLOW_DEV_AUTH !==
// "true"): the `x-security-role` request header is IGNORED. A normal logged-
// in user (arx_user_session only, no hr_session) resolves to VIEWER and
// cannot reach admin/security-write endpoints. Privilege escalation via
// client header is impossible.
//
// Dev/test behavior (NODE_ENV !== "production" OR ALLOW_DEV_AUTH === "true"):
// getSessionFromReq() preserves the legacy `x-security-role` header fallback
// so existing tester pages keep working. This is the *only* place the dev
// fallback lives — auditable single-point gate.
export function readRoleFromRequest(req: Request): RoleKey {
  const session = getSessionFromReq(req);
  return normalizeRole(dbRoleFor(session.role));
}

// Exposed for tests + report. Reflects the runtime authority surface.
export function describeRoleAuthority(): {
  source: "signed_session_cookie";
  productionHeaderAccepted: false;
  devHeaderFallbackActive: boolean;
  isProduction: boolean;
} {
  return {
    source: "signed_session_cookie",
    productionHeaderAccepted: false,
    devHeaderFallbackActive: !IS_PROD || ALLOW_DEV_AUTH,
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

// ── Authority to PULL a stop (REDUCE-only actions) ─────────────────────────
//
// requirePermission() is the right instrument for anything that WIDENS what the
// platform may do. It is the wrong instrument for the emergency stop, and the
// review that followed the rank-7 fix proved it in production terms:
//
//   routes/auth.ts mirrors every regular DB `USER` onto the AuthRole VIEWER,
//   and lib/security/session.ts defaults production to VIEWER. VIEWER does not
//   hold live_trading:kill_switch (lib/security/seed.ts). So wrapping
//   POST /system/kill-switch/engage in requirePermission("live_trading:kill_switch")
//   403'd the ordinary trader on /emergency — the one safety item in every
//   user's nav — and the platform stop silently did not engage.
//
// That gate also protected nothing: POST /bot/emergency-stop (routes/bot.ts,
// requireUser only) reaches the SAME engageKillSwitch() for any signed-in user.
// A gate that every ordinary user can walk around, but that breaks the button
// they were told to press, is pure user-facing harm.
//
// So: pulling a stop needs AUTHENTICATION, not elevation. Releasing it still
// needs requirePermission("live_trading:reset") — authority follows the
// direction of the change, and this direction only ever REDUCES.
//
// Admitted:
//   • any caller with a per-user session (req.authUser) — the ordinary trader;
//   • any caller whose role session holds `permissionKey` (TRADER/ADMIN/OWNER,
//     and the dev role-cookie console, which has no arx_user_session).
// Refused:
//   • anonymous callers — no user session and a role that holds nothing.
export function requireStopAuthority(permissionKey: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // A signed-in human may always pull a stop, whatever their role.
    if (req.authUser) {
      req.securityRole = readRoleFromRequest(req);
      next();
      return;
    }
    // No per-user session: fall back to role authority (operator / dev console).
    const role = readRoleFromRequest(req);
    const decision = await checkPermission(role, permissionKey);
    if (decision.allowed) {
      req.securityRole = role;
      next();
      return;
    }
    res.status(401).json({
      error: "AUTH_REQUIRED",
      message:
        "Sign in to engage the platform emergency stop. Any signed-in user may pull it; releasing it requires an ADMIN or OWNER role.",
      role,
    });
  };
}

export function forbidLiveTradingAction(action: string): { allowed: boolean; reason: string } {
  if (isLiveTradingAction(action)) {
    return { allowed: false, reason: "FORBIDDEN — live trading is permanently disabled by Build NN" };
  }
  return { allowed: true, reason: "OK" };
}

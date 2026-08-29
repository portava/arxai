// Capability #51 — lifecycle-role enforcement middleware.
//
// requireLifecycleRole(role) enforces the separation-of-duties requirement on
// a route. Behavior (pure verdict logic in @workspace/domain security/
// lifecycleRoles — evaluateLifecycleRequirement):
//
//   * SOD not yet configured (ZERO lifecycle grants exist anywhere): the
//     request passes through to the route's existing ADMIN/OWNER gate, and
//     the pass is LOGGED loudly (never silent). Rationale: refusing every
//     admin action on an installation that has never pressed a lifecycle
//     grant would brick the owner with no path to configure the grants.
//   * SOD configured (any grant exists): the caller must HOLD the required
//     role. NOT_HELD → 403 typed. This applies to ADMIN and OWNER alike —
//     that is the point of separation of duties.
//   * Grant-read failure → 403 LIFECYCLE_ROLE_READ_FAILED (fail closed; an
//     unreadable grant table is not permission).
//
// The grant loader is injectable for the offline test lane; production uses
// the security_roles/security_user_roles-backed loader below.

import type { Request, Response, NextFunction } from "express";
import { eq, like } from "drizzle-orm";
import {
  db,
  securityRolesTable,
  securityUserRolesTable,
} from "@workspace/db";
import { security } from "@workspace/domain";
import { logger } from "../logger.js";

const {
  evaluateLifecycleRequirement,
  LIFECYCLE_ROLE_KEY_PREFIX,
} = security;

export interface LifecycleGrantSnapshot {
  /** Lifecycle roles (bare names, no prefix) held by this user. */
  heldRoles: string[];
  /** Whether ANY lifecycle grant exists system-wide. */
  anyGrantsExistSystemWide: boolean;
}

export type LifecycleGrantLoader = (userId: number) => Promise<LifecycleGrantSnapshot>;

/** Production loader: security_roles (LIFECYCLE_*) × security_user_roles. */
export async function loadLifecycleGrants(userId: number): Promise<LifecycleGrantSnapshot> {
  const lifecycleRoles = await db
    .select({ id: securityRolesTable.id, roleKey: securityRolesTable.roleKey })
    .from(securityRolesTable)
    .where(like(securityRolesTable.roleKey, `${LIFECYCLE_ROLE_KEY_PREFIX}%`));
  if (lifecycleRoles.length === 0) {
    return { heldRoles: [], anyGrantsExistSystemWide: false };
  }
  const roleIds = new Map(lifecycleRoles.map((r) => [r.id, r.roleKey]));
  const grants = await db
    .select({ userId: securityUserRolesTable.userId, roleId: securityUserRolesTable.roleId })
    .from(securityUserRolesTable);
  const lifecycleGrants = grants.filter((g) => roleIds.has(g.roleId));
  return {
    heldRoles: lifecycleGrants
      .filter((g) => g.userId === userId)
      .map((g) => roleIds.get(g.roleId)!.slice(LIFECYCLE_ROLE_KEY_PREFIX.length)),
    anyGrantsExistSystemWide: lifecycleGrants.length > 0,
  };
}

/**
 * Express middleware factory. `loader` is injectable for tests; defaults to
 * the DB-backed loader.
 */
export function requireLifecycleRole(
  requiredRole: string,
  loader: LifecycleGrantLoader = loadLifecycleGrants,
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const userId = (req as Request & { authUser?: { id?: number } }).authUser?.id;
    if (!userId) {
      // The route's own auth gate owns the 401; an anonymous caller can never
      // satisfy a lifecycle requirement, so refuse here too (fail closed).
      res.status(401).json({ ok: false, error: "AUTH_REQUIRED" });
      return;
    }

    let snapshot: LifecycleGrantSnapshot;
    try {
      snapshot = await loader(userId);
    } catch (err) {
      logger.warn({ err, userId, requiredRole }, "lifecycle_role_read_failed_fail_closed");
      res.status(403).json({ ok: false, error: "LIFECYCLE_ROLE_READ_FAILED" });
      return;
    }

    const verdict = evaluateLifecycleRequirement({
      requiredRole,
      heldRoles: snapshot.heldRoles,
      anyGrantsExistSystemWide: snapshot.anyGrantsExistSystemWide,
    });

    switch (verdict) {
      case "HELD":
        next();
        return;
      case "SOD_NOT_CONFIGURED":
        // Loud pass-through: separation of duties is not configured on this
        // installation yet; the route's existing ADMIN/OWNER gate still runs.
        logger.warn(
          { userId, requiredRole, path: req.path },
          "lifecycle_sod_not_configured_pass_through",
        );
        next();
        return;
      case "NOT_HELD":
        res.status(403).json({
          ok: false,
          error: "LIFECYCLE_ROLE_REQUIRED",
          requiredRole,
          message: `This action requires the ${requiredRole} lifecycle role.`,
        });
        return;
      case "ROLE_UNKNOWN":
      default:
        // A route wired with an unknown role name is a build defect; refusing
        // is the only honest behavior (never pass on a typo).
        logger.error({ requiredRole, path: req.path }, "lifecycle_role_unknown_in_route_wiring");
        res.status(403).json({ ok: false, error: "LIFECYCLE_ROLE_UNKNOWN" });
        return;
    }
  };
}

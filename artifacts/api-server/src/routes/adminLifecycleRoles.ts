// Capability #51 — Admin lifecycle-role grants (separation of duties).
//
// Routes (ADMIN/OWNER only):
//   GET  /api/admin/lifecycle-roles          — roles, grants, conflict matrix
//   POST /api/admin/lifecycle-roles/grant    — grant ONE role to ONE user
//   POST /api/admin/lifecycle-roles/revoke   — revoke ONE role from ONE user
//
// ENFORCEMENT:
//   * Conflicting combinations are REFUSED (409) by the pure evaluator
//     (@workspace/domain security/lifecycleRoles): author⟂validator,
//     author⟂risk-approver, deployer⟂author/validator/risk-approver,
//     auditor⟂everything. The refusal names every conflicting held role.
//   * Grants persist as security_roles rows (role_key LIFECYCLE_<ROLE>,
//     seeded idempotently, isSystemRole) + security_user_roles rows — the
//     existing RBAC tables, no new grant store.
//   * Every grant/revoke writes admin_action_audit_log.
//   * Route-level enforcement of the roles themselves is
//     requireLifecycleRole(...) (lib/security/lifecycleRoleGate.ts), wired on
//     the lifecycle-relevant surfaces (learning-version approve → DEPLOYER,
//     risk-template mutations → RISK_APPROVER). Rollback is deliberately NOT
//     gated: it is risk-reducing and must never be trapped behind a grant.

import express, { type IRouter, Router, type Request, type Response } from "express";
import { and, eq, like } from "drizzle-orm";
import { z } from "zod/v4";
import {
  db,
  securityRolesTable,
  securityUserRolesTable,
  adminActionAuditLogTable,
} from "@workspace/db";
import { security } from "@workspace/domain";
import { normalizeProductRole, isAdminProductRole } from "../lib/auth/productRole.js";
import { logger } from "../lib/logger.js";

const {
  LIFECYCLE_ROLES,
  CONFLICTING_ROLE_PAIRS,
  LIFECYCLE_ROLE_KEY_PREFIX,
  lifecycleRoleKey,
  evaluateLifecycleRoleGrant,
} = security;

const router: IRouter = Router();
router.use(express.json());

function requireAdmin(req: Request, res: Response): { id: number; role: string } | null {
  const sess = (req as Request & { authUser?: { id: number; role?: string } }).authUser;
  if (!sess?.id) {
    res.status(401).json({ ok: false, error: "AUTH_REQUIRED" });
    return null;
  }
  const role = normalizeProductRole(sess.role);
  if (!isAdminProductRole(role)) {
    res.status(403).json({ ok: false, error: "ADMIN_REQUIRED" });
    return null;
  }
  return { id: sess.id, role };
}

async function tryAudit(args: {
  adminId: number; adminRole: string; action: string;
  targetUserId: number; after: Record<string, unknown>;
}): Promise<void> {
  try {
    await db.insert(adminActionAuditLogTable).values({
      adminId: args.adminId,
      adminRole: args.adminRole,
      action: args.action,
      targetUserId: args.targetUserId,
      beforeState: {},
      afterState: args.after,
    });
  } catch (err) {
    logger.warn({ err, action: args.action }, "admin_lifecycle_roles_audit_write_failed");
  }
}

/** Idempotently ensure the six LIFECYCLE_* security_roles rows exist. */
async function ensureLifecycleRoleRows(): Promise<Map<string, number>> {
  const existing = await db
    .select({ id: securityRolesTable.id, roleKey: securityRolesTable.roleKey })
    .from(securityRolesTable)
    .where(like(securityRolesTable.roleKey, `${LIFECYCLE_ROLE_KEY_PREFIX}%`));
  const byKey = new Map(existing.map((r) => [r.roleKey, r.id]));
  for (const role of LIFECYCLE_ROLES) {
    const key = lifecycleRoleKey(role);
    if (!byKey.has(key)) {
      const [row] = await db.insert(securityRolesTable).values({
        roleKey: key,
        name: `Lifecycle: ${role}`,
        description: `Strategy-lifecycle separation-of-duties role ${role} (capability #51).`,
        isSystemRole: true,
      }).onConflictDoNothing().returning();
      if (row) byKey.set(key, row.id);
      else {
        const [raced] = await db.select({ id: securityRolesTable.id })
          .from(securityRolesTable)
          .where(eq(securityRolesTable.roleKey, key)).limit(1);
        if (raced) byKey.set(key, raced.id);
      }
    }
  }
  return byKey;
}

async function heldLifecycleRoles(
  userId: number,
  roleRows: Map<string, number>,
): Promise<string[]> {
  const idToRole = new Map(
    [...roleRows.entries()].map(([key, id]) => [id, key.slice(LIFECYCLE_ROLE_KEY_PREFIX.length)]),
  );
  const grants = await db
    .select({ roleId: securityUserRolesTable.roleId })
    .from(securityUserRolesTable)
    .where(eq(securityUserRolesTable.userId, userId));
  return grants
    .map((g) => idToRole.get(g.roleId))
    .filter((r): r is string => r != null);
}

// GET /api/admin/lifecycle-roles
router.get("/admin/lifecycle-roles", async (req: Request, res: Response): Promise<void> => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  try {
    const roleRows = await db
      .select()
      .from(securityRolesTable)
      .where(like(securityRolesTable.roleKey, `${LIFECYCLE_ROLE_KEY_PREFIX}%`));
    const roleIds = new Set(roleRows.map((r) => r.id));
    const allGrants = await db.select().from(securityUserRolesTable);
    const grants = allGrants.filter((g) => roleIds.has(g.roleId));
    res.json({
      ok: true,
      roles: LIFECYCLE_ROLES,
      conflictingPairs: CONFLICTING_ROLE_PAIRS,
      sodConfigured: grants.length > 0,
      grants: grants.map((g) => ({
        userId: g.userId,
        role: roleRows.find((r) => r.id === g.roleId)?.roleKey.slice(LIFECYCLE_ROLE_KEY_PREFIX.length) ?? "UNKNOWN",
        assignedBy: g.assignedBy,
        grantedAt: g.createdAt,
      })),
    });
  } catch (err) {
    logger.warn({ err }, "admin_lifecycle_roles_list_failed");
    res.status(500).json({ ok: false, error: "LIFECYCLE_ROLES_READ_FAILED" });
  }
});

const grantSchema = z.object({
  userId: z.number().int().positive(),
  role: z.enum(LIFECYCLE_ROLES),
});

// POST /api/admin/lifecycle-roles/grant
router.post("/admin/lifecycle-roles/grant", async (req: Request, res: Response): Promise<void> => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const parsed = grantSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "INVALID_GRANT", detail: parsed.error.issues });
    return;
  }
  const { userId, role } = parsed.data;
  try {
    const roleRows = await ensureLifecycleRoleRows();
    const held = await heldLifecycleRoles(userId, roleRows);

    const evaluation = evaluateLifecycleRoleGrant(held, role);
    if (!evaluation.allowed) {
      res.status(409).json({
        ok: false,
        error: "LIFECYCLE_GRANT_REFUSED",
        reasons: evaluation.reasons,
        conflictsWith: evaluation.conflictsWith,
        message: evaluation.conflictsWith.length > 0
          ? `Granting ${role} conflicts with held role(s): ${evaluation.conflictsWith.join(", ")}. `
            + "Separation of duties refuses this combination."
          : `Grant refused: ${evaluation.reasons.join(", ")}.`,
      });
      return;
    }

    const roleId = roleRows.get(lifecycleRoleKey(role));
    if (roleId == null) {
      res.status(500).json({ ok: false, error: "LIFECYCLE_ROLE_ROW_MISSING" });
      return;
    }
    await db.insert(securityUserRolesTable).values({
      userId,
      roleId,
      assignedBy: `admin:${admin.id}`,
    });
    await tryAudit({
      adminId: admin.id, adminRole: admin.role,
      action: "LIFECYCLE_ROLE_GRANTED",
      targetUserId: userId,
      after: { role, heldBefore: held },
    });
    res.json({ ok: true, userId, role, heldRoles: [...held, role].sort() });
  } catch (err) {
    logger.warn({ err, userId, role }, "admin_lifecycle_roles_grant_failed");
    res.status(500).json({ ok: false, error: "LIFECYCLE_GRANT_WRITE_FAILED" });
  }
});

// POST /api/admin/lifecycle-roles/revoke
router.post("/admin/lifecycle-roles/revoke", async (req: Request, res: Response): Promise<void> => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const parsed = grantSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "INVALID_REVOKE", detail: parsed.error.issues });
    return;
  }
  const { userId, role } = parsed.data;
  try {
    const [roleRow] = await db
      .select({ id: securityRolesTable.id })
      .from(securityRolesTable)
      .where(eq(securityRolesTable.roleKey, lifecycleRoleKey(role))).limit(1);
    if (!roleRow) {
      res.status(404).json({ ok: false, error: "ROLE_NOT_FOUND" });
      return;
    }
    const removed = await db.delete(securityUserRolesTable)
      .where(and(
        eq(securityUserRolesTable.userId, userId),
        eq(securityUserRolesTable.roleId, roleRow.id),
      )).returning();
    if (removed.length === 0) {
      res.status(404).json({ ok: false, error: "GRANT_NOT_FOUND" });
      return;
    }
    await tryAudit({
      adminId: admin.id, adminRole: admin.role,
      action: "LIFECYCLE_ROLE_REVOKED",
      targetUserId: userId,
      after: { role },
    });
    res.json({ ok: true, userId, role, revoked: true });
  } catch (err) {
    logger.warn({ err, userId, role }, "admin_lifecycle_roles_revoke_failed");
    res.status(500).json({ ok: false, error: "LIFECYCLE_REVOKE_WRITE_FAILED" });
  }
});

export default router;

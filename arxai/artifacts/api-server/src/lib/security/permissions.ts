// Build NN — permission resolution. Forbidden permissions ALWAYS reject.

import { db, securityRolesTable, securityPermissionsTable, securityRolePermissionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { ROLE_KEYS, type RoleKey, ROLE_PERMISSIONS, PERMISSIONS } from "./seed.js";

export interface PermissionDecision {
  allowed: boolean;
  reason: string;
  forbidden: boolean;
  role: string;
  permissionKey: string;
}

const FORBIDDEN_KEYS = new Set(PERMISSIONS.filter((p) => p.forbidden).map((p) => p.key));

export function isValidRole(role: string | undefined | null): role is RoleKey {
  return !!role && (ROLE_KEYS as readonly string[]).includes(role.toUpperCase());
}

export function normalizeRole(role: string | undefined | null): RoleKey {
  const r = (role ?? "").toUpperCase();
  return isValidRole(r) ? r : "VIEWER";
}

export async function checkPermission(role: string | undefined | null, permissionKey: string): Promise<PermissionDecision> {
  const r = normalizeRole(role);
  const key = permissionKey;

  if (FORBIDDEN_KEYS.has(key) || /^forbidden:/.test(key)) {
    return { allowed: false, forbidden: true, role: r, permissionKey: key,
             reason: "FORBIDDEN — this permission is hard-locked and can never be granted (live trading disabled)." };
  }

  // DB-based lookup with safe fallback to seed map.
  try {
    const [roleRow] = await db.select().from(securityRolesTable).where(eq(securityRolesTable.roleKey, r)).limit(1);
    const [permRow] = await db.select().from(securityPermissionsTable).where(eq(securityPermissionsTable.permissionKey, key)).limit(1);
    if (roleRow && permRow) {
      const mapping = await db.select().from(securityRolePermissionsTable)
        .where(eq(securityRolePermissionsTable.roleId, roleRow.id)).limit(500);
      const m = mapping.find((x) => x.permissionId === permRow.id);
      if (m) {
        return { allowed: m.allowed, forbidden: false, role: r, permissionKey: key,
                 reason: m.allowed ? "ALLOWED" : `DENIED — role ${r} does not hold permission ${key}` };
      }
    }
  } catch { /* fall through */ }

  const fallback = ROLE_PERMISSIONS[r] ?? [];
  const ok = fallback.includes(key);
  return { allowed: ok, forbidden: false, role: r, permissionKey: key,
           reason: ok ? "ALLOWED (seed)" : `DENIED — role ${r} does not hold permission ${key}` };
}

// Convenience: forbid live trading & related actions regardless of role.
const LIVE_TRADE_PATTERN = /(live[_-]?trad|can[_-]?place[_-]?trades|broker[_-]?execute|broker[_-]?place[_-]?order|orderSend|positionClose|modify[_-]?order|live[_-]?order|mt5[_-]?live)/i;

export function isLiveTradingAction(actionOrPermission: string): boolean {
  return LIVE_TRADE_PATTERN.test(actionOrPermission);
}

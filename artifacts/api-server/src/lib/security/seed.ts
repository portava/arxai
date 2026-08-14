// Build NN — seed roles + permissions. Idempotent.

import { db, securityRolesTable, securityPermissionsTable, securityRolePermissionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

export const ROLE_KEYS = ["OWNER", "ADMIN", "TRADER", "ANALYST", "VIEWER", "SYSTEM"] as const;
export type RoleKey = typeof ROLE_KEYS[number];

interface PermDef { key: string; name: string; category: string; forbidden?: boolean; }

export const PERMISSIONS: PermDef[] = [
  { key: "decision:read", name: "Read decisions", category: "AA" },
  { key: "decision:create", name: "Create decision", category: "AA" },
  { key: "paper_trade:read", name: "Read paper trades", category: "EE" },
  { key: "paper_trade:create", name: "Create paper trade", category: "EE" },
  { key: "paper_trade:close", name: "Close paper trade", category: "EE" },
  { key: "paper_autopilot:read", name: "Read autopilot", category: "FF" },
  { key: "paper_autopilot:start", name: "Start autopilot", category: "FF" },
  { key: "paper_autopilot:stop", name: "Stop autopilot", category: "FF" },
  { key: "replay:read", name: "Read replay", category: "JJ" },
  { key: "replay:run", name: "Run replay", category: "JJ" },
  { key: "strategy_lab:run", name: "Run strategy lab", category: "JJ" },
  { key: "performance:read", name: "Read performance", category: "GG" },
  { key: "coach:read", name: "Read coach", category: "II" },
  { key: "coach:generate", name: "Generate coach report", category: "II" },
  { key: "risk_governor:read", name: "Read risk governor", category: "HH" },
  { key: "risk_governor:evaluate", name: "Evaluate risk", category: "HH" },
  { key: "notifications:read", name: "Read notifications", category: "LL" },
  { key: "notifications:manage", name: "Manage notifications", category: "LL" },
  { key: "data_import:read", name: "Read imports", category: "KK" },
  { key: "data_import:create", name: "Create import", category: "KK" },
  { key: "broker_readonly:read", name: "Read broker snapshot", category: "KK" },
  { key: "admin:health_check", name: "Run health check", category: "MM" },
  { key: "admin:watch_only", name: "Trigger WATCH_ONLY", category: "MM" },
  { key: "admin:rebuild", name: "Rebuild performance", category: "MM" },
  { key: "audit:read", name: "Read audit", category: "MM" },
  { key: "audit:export", name: "Export audit", category: "MM" },
  { key: "security:read", name: "Read security", category: "NN" },
  { key: "security:manage_roles", name: "Manage roles", category: "NN" },
  { key: "security:manage_settings", name: "Manage security settings", category: "NN" },
  { key: "live_trading:read", name: "Read live-trading state", category: "TT" },
  { key: "live_trading:arm", name: "Arm/disarm live trading", category: "TT" },
  { key: "live_trading:approve", name: "Approve live trade card", category: "TT" },
  { key: "live_trading:kill_switch", name: "Engage kill switch", category: "TT" },
  { key: "live_trading:reset", name: "Reset kill switch (admin)", category: "TT" },
  { key: "forbidden:live_trade_enable", name: "Enable live trading", category: "FORBIDDEN", forbidden: true },
  { key: "forbidden:broker_execute", name: "Broker execute", category: "FORBIDDEN", forbidden: true },
  { key: "forbidden:set_can_place_trades_true", name: "Set canPlaceTrades true", category: "FORBIDDEN", forbidden: true },
];

export const ROLE_PERMISSIONS: Record<RoleKey, string[]> = {
  OWNER: PERMISSIONS.filter((p) => !p.forbidden).map((p) => p.key),
  ADMIN: PERMISSIONS.filter((p) => !p.forbidden && p.category !== "NN").map((p) => p.key)
    .concat(["security:read"]),
  TRADER: [
    "decision:read","decision:create","paper_trade:read","paper_trade:create","paper_trade:close",
    "paper_autopilot:read","paper_autopilot:start","paper_autopilot:stop",
    "replay:read","replay:run","performance:read","coach:read","risk_governor:read",
    "notifications:read","data_import:read","broker_readonly:read",
    "live_trading:read","live_trading:arm","live_trading:approve","live_trading:kill_switch",
  ],
  ANALYST: [
    "decision:read","paper_trade:read","paper_autopilot:read","replay:read","strategy_lab:run",
    "performance:read","coach:read","coach:generate","risk_governor:read",
    "notifications:read","data_import:read","broker_readonly:read","audit:read",
  ],
  VIEWER: [
    "decision:read","paper_trade:read","paper_autopilot:read","performance:read",
    "coach:read","notifications:read",
  ],
  SYSTEM: PERMISSIONS.filter((p) => !p.forbidden).map((p) => p.key),
};

export interface SeedResult { rolesCreated: number; permissionsCreated: number; mappingsCreated: number; }

export async function seedSecurity(): Promise<SeedResult> {
  let rolesCreated = 0, permissionsCreated = 0, mappingsCreated = 0;

  for (const key of ROLE_KEYS) {
    const existing = await db.select().from(securityRolesTable).where(eq(securityRolesTable.roleKey, key)).limit(1);
    if (existing.length === 0) {
      await db.insert(securityRolesTable).values({
        roleKey: key, name: key, description: `${key} role`, isSystemRole: key === "SYSTEM",
      });
      rolesCreated++;
    }
  }

  for (const p of PERMISSIONS) {
    const existing = await db.select().from(securityPermissionsTable).where(eq(securityPermissionsTable.permissionKey, p.key)).limit(1);
    if (existing.length === 0) {
      await db.insert(securityPermissionsTable).values({
        permissionKey: p.key, name: p.name, description: p.name, category: p.category, isForbidden: !!p.forbidden,
      });
      permissionsCreated++;
    }
  }

  const allRoles = await db.select().from(securityRolesTable);
  const allPerms = await db.select().from(securityPermissionsTable);
  const roleByKey = new Map(allRoles.map((r) => [r.roleKey, r.id]));
  const permByKey = new Map(allPerms.map((p) => [p.permissionKey, p.id]));

  for (const role of ROLE_KEYS) {
    const roleId = roleByKey.get(role);
    if (!roleId) continue;
    const allowed = new Set(ROLE_PERMISSIONS[role]);
    for (const perm of PERMISSIONS) {
      if (perm.forbidden) continue;
      const permId = permByKey.get(perm.key);
      if (!permId) continue;
      const ok = allowed.has(perm.key);
      const existing = await db.select().from(securityRolePermissionsTable)
        .where(eq(securityRolePermissionsTable.roleId, roleId)).limit(500);
      if (!existing.find((r) => r.permissionId === permId)) {
        await db.insert(securityRolePermissionsTable).values({ roleId, permissionId: permId, allowed: ok });
        mappingsCreated++;
      }
    }
  }

  return { rolesCreated, permissionsCreated, mappingsCreated };
}

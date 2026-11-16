// Agent Ecosystem — idempotent core-agent seed (Layer 1).
//
// Upserts the 14 CORE_AGENTS by agentKey. Re-running is a no-op: existing rows
// are left untouched (we never overwrite earned scores/status). Parent links
// are resolved in a second pass once all rows exist.
//
// SAFETY: writing agent records NEVER touches any trade/live/demo path. New
// non-mapped agents are persisted in Shadow Mode at 0% authority with
// liveInfluenceAllowed=false, exactly as defined in CORE_AGENTS.

import { db, agentsTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { CORE_AGENTS, type CoreAgentDef } from "@workspace/domain/agent-system";

export interface SeedResult {
  total: number;
  created: number;
  existing: number;
  createdKeys: string[];
}

function toInsertRow(def: CoreAgentDef) {
  return {
    agentKey: def.agentKey,
    name: def.name,
    role: def.role,
    department: def.department,
    missionStatement: def.missionStatement,
    allowedTasks: JSON.stringify(def.allowedTasks),
    forbiddenTasks: JSON.stringify(def.forbiddenTasks),
    currentRank: def.startingRank,
    currentStatus: def.startingStatus,
    currentMode: def.startingMode,
    authorityWeight: def.authorityWeight,
    liveInfluenceAllowed: def.liveInfluenceAllowed,
    canCreateAgents: def.canCreateAgents,
    creationRightLevel: def.creationRightLevel,
    specialtyTags: JSON.stringify(def.specialtyTags),
    isCore: true,
  };
}

/**
 * Idempotently ensure the 14 core agents exist. Returns counts. Safe to call
 * on every boot and from the admin seed endpoint.
 */
export async function seedCoreAgents(): Promise<SeedResult> {
  const keys = CORE_AGENTS.map((a) => a.agentKey);
  const existingRows = await db
    .select({ agentKey: agentsTable.agentKey })
    .from(agentsTable)
    .where(inArray(agentsTable.agentKey, keys));
  const existingKeys = new Set(existingRows.map((r) => r.agentKey));

  const toCreate = CORE_AGENTS.filter((a) => !existingKeys.has(a.agentKey));
  if (toCreate.length > 0) {
    await db
      .insert(agentsTable)
      .values(toCreate.map(toInsertRow))
      .onConflictDoNothing({ target: agentsTable.agentKey });
  }

  // Second pass: resolve parent links for any row missing one.
  const allRows = await db
    .select({ id: agentsTable.id, agentKey: agentsTable.agentKey, parentAgentId: agentsTable.parentAgentId })
    .from(agentsTable)
    .where(inArray(agentsTable.agentKey, keys));
  const idByKey = new Map(allRows.map((r) => [r.agentKey, r.id]));

  for (const def of CORE_AGENTS) {
    if (!def.parentAgentKey) continue;
    const row = allRows.find((r) => r.agentKey === def.agentKey);
    if (!row || row.parentAgentId != null) continue;
    const parentId = idByKey.get(def.parentAgentKey);
    if (parentId == null) continue;
    await db
      .update(agentsTable)
      .set({ parentAgentId: parentId, updatedAt: new Date() })
      .where(eq(agentsTable.id, row.id));
  }

  return {
    total: CORE_AGENTS.length,
    created: toCreate.length,
    existing: CORE_AGENTS.length - toCreate.length,
    createdKeys: toCreate.map((a) => a.agentKey),
  };
}

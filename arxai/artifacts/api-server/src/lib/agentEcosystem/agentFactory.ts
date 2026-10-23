// Agent Ecosystem — Layer 3 Governed Agent Factory service (persistence wiring).
//
// Bridges the PURE Factory validator (agentFactory.engine.ts) to the DB. A request
// is validated + normalized in the pure layer, persisted as a PROPOSED row, and
// only ever mints a new agent on explicit admin/OWNER APPROVAL.
//
// SAFETY / SCOPE (inviolable):
//   - A created agent is ALWAYS born SHADOW, authorityWeight 0, liveInfluenceAllowed
//     false, canCreateAgents false, creationRightLevel NONE — forced by the pure
//     normalized spec, never caller-controllable. Earned authority comes later only
//     from the Promotion Board.
//   - A PROPOSED request NEVER auto-activates an agent. Approval is admin/OWNER only.
//   - Requests with any universally-forbidden permission, or that are duplicate /
//     under-specified, are rejected by the pure validator before any DB write.
//   - Nothing here touches a trade/live/demo path or the 16-gate live pipeline.

import {
  db, agentsTable, agentCreationRequestsTable, agentEcosystemSettingsTable,
} from "@workspace/db";
import type {
  AgentCreationRequestRow,
  AgentCreationRequestInsertRow,
} from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import {
  validateAgentCreationRequest,
  evaluateCreationEligibility,
  UNIVERSAL_FORBIDDEN,
  type AgentCreationRequestInput,
  type ExistingAgentLite,
  type DepartmentAgentLite,
  type ParentAgentContext,
  type NormalizedAgentCreationSpec,
  type AgentRank,
} from "@workspace/domain/agent-system";
import { isUniqueViolation } from "../pgError.js";

/** Any drizzle executor — the base `db` handle or an open transaction. */
type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Same name normalization the pure validator uses for duplicate detection. */
function normName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

export type FactoryRequestStatus = "PROPOSED" | "APPROVED" | "REJECTED";

export interface ProposeResult {
  ok: boolean;
  /** Validation errors from the pure validator (present when ok=false). */
  errors?: string[];
  request?: AgentCreationRequestRow;
}

export interface DecisionResult {
  ok: boolean;
  error?: string;
  request?: AgentCreationRequestRow;
  /** The id of the SHADOW agent minted on APPROVE. */
  createdAgentId?: number;
}

async function loadExistingAgentsLite(): Promise<DepartmentAgentLite[]> {
  const rows = await db
    .select({
      agentKey: agentsTable.agentKey,
      name: agentsTable.name,
      department: agentsTable.department,
      currentRank: agentsTable.currentRank,
      currentStatus: agentsTable.currentStatus,
    })
    .from(agentsTable);
  return rows;
}

const VALID_RANKS: ReadonlySet<string> = new Set([
  "TRAINEE", "JUNIOR", "ANALYST", "SENIOR", "LEAD", "CHIEF",
]);

/**
 * Read (lazily creating) the singleton Agent Ecosystem settings row. Fail-safe:
 * if the row is missing it is created with creation NOT frozen.
 */
export async function getEcosystemSettings(): Promise<{
  creationFrozen: boolean;
  creationFrozenReason: string | null;
  backgroundRunnerEnabled: boolean;
}> {
  const [row] = await db.select().from(agentEcosystemSettingsTable).limit(1);
  if (row) {
    return {
      creationFrozen: row.creationFrozen,
      creationFrozenReason: row.creationFrozenReason,
      backgroundRunnerEnabled: row.backgroundRunnerEnabled,
    };
  }
  const [created] = await db
    .insert(agentEcosystemSettingsTable)
    .values({ creationFrozen: false })
    .returning();
  return {
    creationFrozen: created.creationFrozen,
    creationFrozenReason: created.creationFrozenReason,
    backgroundRunnerEnabled: created.backgroundRunnerEnabled,
  };
}

/**
 * Phase 6 — admin opt-in master switch for the background lifecycle runner
 * (singleton id=1). Returns the new state. The caller is responsible for the
 * audit-log row. Advisory/shadow only — flipping this NEVER affects any
 * trade/live/demo path or the 16-gate live pipeline.
 */
export async function setBackgroundRunnerEnabled(
  enabled: boolean,
  updatedByUserId: number | null,
): Promise<{ backgroundRunnerEnabled: boolean }> {
  const [existing] = await db.select({ id: agentEcosystemSettingsTable.id })
    .from(agentEcosystemSettingsTable).limit(1);
  if (!existing) {
    const [created] = await db.insert(agentEcosystemSettingsTable)
      .values({ backgroundRunnerEnabled: enabled, updatedByUserId, updatedAt: new Date() })
      .returning();
    return { backgroundRunnerEnabled: created.backgroundRunnerEnabled };
  }
  const [updated] = await db.update(agentEcosystemSettingsTable)
    .set({ backgroundRunnerEnabled: enabled, updatedByUserId, updatedAt: new Date() })
    .where(eq(agentEcosystemSettingsTable.id, existing.id))
    .returning();
  return { backgroundRunnerEnabled: updated.backgroundRunnerEnabled };
}

/**
 * Set the §15 admin master freeze-all switch (singleton id=1). Returns the new
 * state. The caller is responsible for the audit-log row.
 */
export async function setCreationFrozen(
  frozen: boolean,
  reason: string,
  updatedByUserId: number,
): Promise<{ creationFrozen: boolean; creationFrozenReason: string | null }> {
  const [existing] = await db.select({ id: agentEcosystemSettingsTable.id })
    .from(agentEcosystemSettingsTable).limit(1);
  if (!existing) {
    const [created] = await db.insert(agentEcosystemSettingsTable)
      .values({ creationFrozen: frozen, creationFrozenReason: reason, updatedByUserId, updatedAt: new Date() })
      .returning();
    return { creationFrozen: created.creationFrozen, creationFrozenReason: created.creationFrozenReason };
  }
  const [updated] = await db.update(agentEcosystemSettingsTable)
    .set({ creationFrozen: frozen, creationFrozenReason: reason, updatedByUserId, updatedAt: new Date() })
    .where(eq(agentEcosystemSettingsTable.id, existing.id))
    .returning();
  return { creationFrozen: updated.creationFrozen, creationFrozenReason: updated.creationFrozenReason };
}

/**
 * Build the §8/§15 parent-agent governance context from the registry for a
 * named parent. Returns null when the parent agent key does not exist. childCount
 * and msSinceLastCreation are derived from the parent's children in the registry.
 */
async function loadParentContext(parentAgentKey: string): Promise<ParentAgentContext | null> {
  const [parent] = await db
    .select({
      id: agentsTable.id,
      agentKey: agentsTable.agentKey,
      name: agentsTable.name,
      currentRank: agentsTable.currentRank,
      trustScore: agentsTable.trustScore,
      canCreateAgents: agentsTable.canCreateAgents,
    })
    .from(agentsTable)
    .where(eq(agentsTable.agentKey, parentAgentKey))
    .limit(1);
  if (!parent) return null;

  const children = await db
    .select({ createdAt: agentsTable.createdAt })
    .from(agentsTable)
    .where(eq(agentsTable.parentAgentId, parent.id));
  let msSinceLastCreation: number | undefined;
  if (children.length > 0) {
    const newest = children.reduce(
      (max, c) => Math.max(max, c.createdAt?.getTime() ?? 0),
      0,
    );
    if (newest > 0) msSinceLastCreation = Date.now() - newest;
  }

  const rank: AgentRank = VALID_RANKS.has(parent.currentRank)
    ? (parent.currentRank as AgentRank)
    : "TRAINEE";
  return {
    agentKey: parent.agentKey,
    name: parent.name,
    rank,
    trustScore: parent.trustScore,
    canCreateAgents: parent.canCreateAgents,
    childCount: children.length,
    msSinceLastCreation,
  };
}

/**
 * Governance assertions the caller supplies for a parent-initiated (§8/§15)
 * creation. All default to the SAFE (deny) side — an agent-initiated creation
 * must positively assert immune/risk clearance and a documented task gap.
 */
export interface ProposeGovernanceContext {
  immuneApproved?: boolean;
  riskClear?: boolean;
  taskGapEvidenceCount?: number;
  missingSpecialty?: boolean;
}

export interface ProposeOptions {
  requestedByAgentId?: number | null;
  governance?: ProposeGovernanceContext;
}

/**
 * Validate + normalize a creation request and, if valid, persist it as a PROPOSED
 * row. Returns the validation errors without writing anything when invalid.
 *
 * Governance enforcement (§8/§15):
 *   - The admin master freeze-all switch blocks EVERY proposal while engaged.
 *   - When a `parentAgentKey` is named, the FULL default-deny eligibility engine
 *     runs (creation rights by rank, parent trust, cooldown, population caps,
 *     immune/risk clearance, task-gap evidence) — ANY failure blocks the write.
 *   - With no parent (admin bootstrap), the PURE request validator gates fields,
 *     forbidden permissions, and duplicate names. Either way the agent is born
 *     forced-shadow at 0 authority.
 */
export async function proposeAgentCreation(
  input: AgentCreationRequestInput,
  requestedByUserId: number,
  opts: ProposeOptions = {},
): Promise<ProposeResult> {
  const requestedByAgentId = opts.requestedByAgentId ?? null;
  const existing = await loadExistingAgentsLite();

  // §15 admin master freeze-all — blocks all creation while engaged.
  const settings = await getEcosystemSettings();
  if (settings.creationFrozen) {
    return { ok: false, errors: ["creation_frozen_by_admin"] };
  }

  let spec: NormalizedAgentCreationSpec;
  if (input.parentAgentKey) {
    // §8/§15 agent-initiated path — full default-deny eligibility evaluation.
    const parent = await loadParentContext(input.parentAgentKey);
    if (!parent) {
      return { ok: false, errors: ["parent_agent_not_found"] };
    }
    const eligibility = evaluateCreationEligibility({
      request: input,
      parent,
      existingAgents: existing,
      immuneApproved: opts.governance?.immuneApproved ?? false,
      riskClear: opts.governance?.riskClear ?? false,
      taskGapEvidenceCount: opts.governance?.taskGapEvidenceCount ?? 0,
      missingSpecialty: opts.governance?.missingSpecialty ?? false,
      creationFrozen: settings.creationFrozen,
    });
    if (!eligibility.eligible || !eligibility.normalized) {
      return { ok: false, errors: eligibility.blockReasons };
    }
    spec = eligibility.normalized;
  } else {
    // Admin bootstrap path — PURE request validator only.
    const validation = validateAgentCreationRequest(input, existing);
    if (!validation.valid || !validation.normalized) {
      return { ok: false, errors: validation.errors };
    }
    spec = validation.normalized;
  }

  // Duplicate-PROPOSED guard (before any write): the pure validator only dedupes
  // against existing AGENTS; it cannot see other pending requests. Reject a second
  // proposal for a name already awaiting decision. The DB partial-unique index
  // (lower(proposed_name) WHERE status='PROPOSED') is the race backstop.
  const pending = await db
    .select({ proposedName: agentCreationRequestsTable.proposedName })
    .from(agentCreationRequestsTable)
    .where(eq(agentCreationRequestsTable.status, "PROPOSED"));
  const target = normName(spec.proposedName);
  if (pending.some((p) => normName(p.proposedName) === target)) {
    return { ok: false, errors: ["duplicate_pending_request"] };
  }

  const insertRow: AgentCreationRequestInsertRow = {
    proposedName: spec.proposedName,
    proposedDepartment: spec.proposedDepartment,
    purpose: spec.purpose,
    reasonNeeded: spec.reasonNeeded,
    workflowGap: spec.workflowGap,
    allowedInputs: JSON.stringify(spec.allowedInputs),
    allowedOutputs: JSON.stringify(spec.allowedOutputs),
    permissions: JSON.stringify(spec.permissions),
    failureConditions: JSON.stringify(spec.failureConditions),
    scorecard: JSON.stringify(spec.scorecard),
    testingRequirements: JSON.stringify(spec.testingRequirements),
    activationRequirements: JSON.stringify(spec.activationRequirements),
    parentAgentKey: spec.parentAgentKey,
    normalizedSpec: JSON.stringify(spec),
    status: "PROPOSED",
    requestedByUserId,
    requestedByAgentId: requestedByAgentId ?? null,
  };
  try {
    const [row] = await db
      .insert(agentCreationRequestsTable)
      .values(insertRow)
      .returning();
    return { ok: true, request: row };
  } catch (err) {
    // Race backstop: if a concurrent proposal slipped past the read above, the
    // partial-unique index raises a Postgres unique-violation (23505). Map it to
    // the same deterministic response the precheck returns. The insert above uses
    // the top-level `db` (never a tx executor), so the 23505 is not wrapped today;
    // isUniqueViolation walks the cause chain anyway so this stays correct if the
    // insert is ever moved inside db.transaction(...).
    if (isUniqueViolation(err)) {
      return { ok: false, errors: ["duplicate_pending_request"] };
    }
    throw err;
  }
}

export interface ListRequestsOptions {
  status?: FactoryRequestStatus;
  limit?: number;
}

export async function listAgentCreationRequests(
  opts: ListRequestsOptions = {},
): Promise<AgentCreationRequestRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const base = db.select().from(agentCreationRequestsTable);
  const rows = await (opts.status
    ? base.where(eq(agentCreationRequestsTable.status, opts.status))
    : base)
    .orderBy(desc(agentCreationRequestsTable.createdAt))
    .limit(limit);
  return rows;
}

/** Build a unique, stable agentKey from a proposed name. */
function slugKey(name: string): string {
  const base = name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return base.length > 0 ? base : "AGENT";
}

async function resolveUniqueAgentKey(tx: DbExecutor, name: string): Promise<string> {
  const base = slugKey(name);
  const existing = await tx
    .select({ agentKey: agentsTable.agentKey })
    .from(agentsTable);
  const taken = new Set(existing.map((r) => r.agentKey));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}_${Date.now()}`;
}

async function resolveParentAgentId(
  tx: DbExecutor,
  parentAgentKey: string | null,
): Promise<number | null> {
  if (!parentAgentKey) return null;
  const [row] = await tx
    .select({ id: agentsTable.id })
    .from(agentsTable)
    .where(eq(agentsTable.agentKey, parentAgentKey))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Mint a SHADOW agent from an approved normalized spec. The agent is FORCED to be
 * born shadow / 0-authority / no-live-influence regardless of spec content.
 */
async function mintShadowAgent(
  tx: DbExecutor,
  spec: NormalizedAgentCreationSpec,
  decidedByUserId: number,
): Promise<number> {
  const agentKey = await resolveUniqueAgentKey(tx, spec.proposedName);
  const parentAgentId = await resolveParentAgentId(tx, spec.parentAgentKey);
  const [agent] = await tx
    .insert(agentsTable)
    .values({
      agentKey,
      name: spec.proposedName,
      role: "GOVERNED_SHADOW_AGENT",
      department: spec.proposedDepartment,
      parentAgentId,
      createdByUserId: decidedByUserId,
      creationReason: spec.reasonNeeded,
      missionStatement: spec.purpose,
      allowedTasks: JSON.stringify(spec.allowedOutputs),
      forbiddenTasks: JSON.stringify([...UNIVERSAL_FORBIDDEN]),
      // Forced governance defaults — born shadow, zero authority, zero influence.
      currentRank: "TRAINEE",
      currentStatus: "SHADOW",
      currentMode: "SHADOW",
      authorityWeight: 0,
      liveInfluenceAllowed: false,
      canCreateAgents: false,
      creationRightLevel: "NONE",
      specialtyTags: JSON.stringify([]),
      isCore: false,
    })
    .returning({ id: agentsTable.id });
  return agent.id;
}

export interface DecideOptions {
  id: number;
  decision: "APPROVE" | "REJECT";
  decidedByUserId: number;
  reason: string;
}

/**
 * Approve (mint a SHADOW agent) or reject a PROPOSED request. Only PROPOSED rows
 * are decidable; a re-decision is refused. Approval is the ONLY path that creates
 * an agent, and the agent is always born shadow at 0% authority.
 */
export async function decideAgentCreationRequest(opts: DecideOptions): Promise<DecisionResult> {
  return db.transaction(async (tx) => {
    // Pre-parse the spec OUTSIDE the claim so a corrupt approve never claims the
    // row (leaving it stuck non-PROPOSED). The CAS claim below is the atomicity
    // guard: only ONE concurrent decision can flip status from PROPOSED, so an
    // approve can mint at most once.
    const [row] = await tx
      .select()
      .from(agentCreationRequestsTable)
      .where(eq(agentCreationRequestsTable.id, opts.id))
      .limit(1);
    if (!row) return { ok: false, error: "REQUEST_NOT_FOUND" };
    if (row.status !== "PROPOSED") {
      return { ok: false, error: `REQUEST_NOT_PROPOSED:${row.status}` };
    }

    if (opts.decision === "REJECT") {
      const claimed = await tx
        .update(agentCreationRequestsTable)
        .set({
          status: "REJECTED",
          decidedByUserId: opts.decidedByUserId,
          decisionReason: opts.reason,
          decidedAt: new Date(),
        })
        .where(and(
          eq(agentCreationRequestsTable.id, opts.id),
          eq(agentCreationRequestsTable.status, "PROPOSED"),
        ))
        .returning();
      if (claimed.length === 0) return { ok: false, error: "REQUEST_NOT_PROPOSED" };
      return { ok: true, request: claimed[0] };
    }

    // APPROVE → parse the persisted normalized spec, then atomically CLAIM the row.
    let spec: NormalizedAgentCreationSpec;
    try {
      spec = JSON.parse(row.normalizedSpec) as NormalizedAgentCreationSpec;
    } catch {
      return { ok: false, error: "NORMALIZED_SPEC_CORRUPT" };
    }
    const claimed = await tx
      .update(agentCreationRequestsTable)
      .set({
        status: "APPROVED",
        decidedByUserId: opts.decidedByUserId,
        decisionReason: opts.reason,
        decidedAt: new Date(),
      })
      .where(and(
        eq(agentCreationRequestsTable.id, opts.id),
        eq(agentCreationRequestsTable.status, "PROPOSED"),
      ))
      .returning();
    if (claimed.length === 0) return { ok: false, error: "REQUEST_NOT_PROPOSED" };

    // Row is ours — mint exactly once and record the created agent id.
    const createdAgentId = await mintShadowAgent(tx, spec, opts.decidedByUserId);
    const [updated] = await tx
      .update(agentCreationRequestsTable)
      .set({ createdAgentId })
      .where(eq(agentCreationRequestsTable.id, opts.id))
      .returning();
    return { ok: true, request: updated, createdAgentId };
  });
}

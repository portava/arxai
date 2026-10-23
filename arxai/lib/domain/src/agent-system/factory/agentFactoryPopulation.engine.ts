// Agent Ecosystem — Layer 3 Factory eligibility, birth certificate, population
// control, and cleanup recommendations (§8, §15, §16). PURE.
//
// PURPOSE
//   Wrap the existing PURE creation-request validator with the GOVERNANCE rules
//   the Factory must enforce: creation rights by rank, full creation eligibility
//   (rank/trust + rights + repeated task gap + missing specialty + non-duplicate
//   + immune approval + risk clear + population caps + cooldown + admin freeze),
//   a §8 birth certificate (always Shadow Mode, 0% authority), parent
//   accountability, and §16 cleanup (merge/retire/absorb/archive/quarantine).
//
// SAFETY / SCOPE (inviolable):
//   - A created agent is ALWAYS born SHADOW at 0% authority, no live influence.
//     Earned authority comes only later from the Promotion Board.
//   - Eligibility is default-DENY: any failed gate blocks creation.
//   - Nothing here mutates state or touches I/O; persistence + admin approval
//     live in the api-server layer.
//   - PURE: deterministic, no I/O, no clock, no DB.

import {
  validateAgentCreationRequest,
  type AgentCreationRequestInput,
  type ExistingAgentLite,
  type NormalizedAgentCreationSpec,
} from "../governance/agentFactory.engine";
import type { AgentRank } from "../promotion/promotionBoard.engine";
import { RANK_ORDER } from "../promotion/promotionBoard.engine";

// ── Creation rights by rank (§15) ──────────────────────────────────────────
export type CreationRight =
  | "NONE"               // Trainee
  | "SUGGEST"            // Junior
  | "REQUEST"            // Analyst
  | "CREATE_SHADOW"      // Senior (if allowed)
  | "CREATE_SUPERVISE"   // Lead
  | "PROPOSE_RESTRUCTURE"; // Chief

const RIGHT_BY_RANK: Record<AgentRank, CreationRight> = {
  TRAINEE: "NONE",
  JUNIOR: "SUGGEST",
  ANALYST: "REQUEST",
  SENIOR: "CREATE_SHADOW",
  LEAD: "CREATE_SUPERVISE",
  CHIEF: "PROPOSE_RESTRUCTURE",
};

export function creationRightForRank(rank: AgentRank): CreationRight {
  return RIGHT_BY_RANK[rank] ?? "NONE";
}

/** Ranks that can actually mint a (shadow) child without admin escalation. */
const CAN_CREATE_RIGHTS = new Set<CreationRight>(["CREATE_SHADOW", "CREATE_SUPERVISE"]);

export interface ParentAgentContext {
  agentKey: string;
  name: string;
  rank: AgentRank;
  trustScore: number;        // 0-100
  /** Explicit creation-rights flag from the registry. */
  canCreateAgents: boolean;
  /** Children this parent already supervises. */
  childCount: number;
  /** Last creation timestamp delta in ms (caller computes vs now). */
  msSinceLastCreation?: number;
}

export interface PopulationLimits {
  maxActivePerDepartment: number;
  maxTraineePerDepartment: number;
  maxChildrenPerParent: number;
  /** Minimum parent trust to create. */
  minParentTrust: number;
  /** Creation cooldown in ms between creations by the same parent. */
  creationCooldownMs: number;
}

export const DEFAULT_POPULATION_LIMITS: PopulationLimits = {
  maxActivePerDepartment: 6,
  maxTraineePerDepartment: 3,
  maxChildrenPerParent: 5,
  minParentTrust: 65,
  creationCooldownMs: 24 * 60 * 60 * 1000, // 24h
};

export interface CreationEligibilityInput {
  request: AgentCreationRequestInput;
  parent: ParentAgentContext;
  existingAgents: readonly DepartmentAgentLite[];
  /** Immune system has cleared this as non-duplicate / non-bloat. */
  immuneApproved: boolean;
  /** Risk AI has NOT flagged danger for this creation. */
  riskClear: boolean;
  /** Proof of a repeated failure pattern / task gap (>= 1 documented instance). */
  taskGapEvidenceCount: number;
  /** True when the specialty is genuinely missing (not already covered). */
  missingSpecialty: boolean;
  limits?: Partial<PopulationLimits>;
  /** Admin master freeze-all switch. */
  creationFrozen?: boolean;
}

export interface DepartmentAgentLite extends ExistingAgentLite {
  currentRank: string;
  currentStatus: string;
}

export interface CreationEligibility {
  eligible: boolean;
  /** Neutral machine block reasons; default-deny — non-empty means blocked. */
  blockReasons: string[];
  creationRight: CreationRight;
  /** Present only when eligible — the validated, forced-shadow spec. */
  normalized?: NormalizedAgentCreationSpec;
  /** True when a Senior creation additionally needs admin approval to leave shadow. */
  requiresAdminApprovalToLeaveShadow: boolean;
}

/**
 * Full default-deny creation eligibility (§8 + §15). Runs the PURE request
 * validator first, then layers the governance gates. ANY failure → eligible:false.
 */
export function evaluateCreationEligibility(input: CreationEligibilityInput): CreationEligibility {
  const limits = { ...DEFAULT_POPULATION_LIMITS, ...(input.limits ?? {}) };
  const right = creationRightForRank(input.parent.rank);
  const blockReasons: string[] = [];

  // 1) Admin freeze-all.
  if (input.creationFrozen) blockReasons.push("creation_frozen_by_admin");

  // 2) Rank / rights.
  if (!CAN_CREATE_RIGHTS.has(right)) {
    blockReasons.push(`insufficient_creation_right:${right}`);
  }
  if (!input.parent.canCreateAgents) {
    blockReasons.push("parent_creation_rights_revoked");
  }

  // 3) Parent trust.
  if (input.parent.trustScore < limits.minParentTrust) {
    blockReasons.push(`parent_trust_too_low:${input.parent.trustScore.toFixed(0)}<${limits.minParentTrust}`);
  }

  // 4) Repeated task gap + missing specialty proof.
  if (input.taskGapEvidenceCount < 1) blockReasons.push("no_repeated_task_gap_evidence");
  if (!input.missingSpecialty) blockReasons.push("specialty_already_covered");

  // 5) Immune + risk clearance.
  if (!input.immuneApproved) blockReasons.push("immune_system_flagged_duplication_or_bloat");
  if (!input.riskClear) blockReasons.push("risk_ai_flagged_danger");

  // 6) Cooldown.
  if (
    typeof input.parent.msSinceLastCreation === "number" &&
    input.parent.msSinceLastCreation < limits.creationCooldownMs
  ) {
    blockReasons.push("creation_cooldown_active");
  }

  // 7) Population caps for the target department.
  const dept = input.request.proposedDepartment?.trim() ?? "";
  const inDept = input.existingAgents.filter((a) => a.department === dept);
  const activeInDept = inDept.filter((a) => a.currentStatus.toUpperCase() === "ACTIVE").length;
  const traineeInDept = inDept.filter((a) => a.currentRank.toUpperCase() === "TRAINEE").length;
  if (activeInDept >= limits.maxActivePerDepartment) {
    blockReasons.push(`department_active_cap_reached:${activeInDept}>=${limits.maxActivePerDepartment}`);
  }
  if (traineeInDept >= limits.maxTraineePerDepartment) {
    blockReasons.push(`department_trainee_cap_reached:${traineeInDept}>=${limits.maxTraineePerDepartment}`);
  }
  if (input.parent.childCount >= limits.maxChildrenPerParent) {
    blockReasons.push(`parent_children_cap_reached:${input.parent.childCount}>=${limits.maxChildrenPerParent}`);
  }

  // 8) PURE request validation (fields + forbidden permissions + duplicate name).
  const validation = validateAgentCreationRequest(input.request, input.existingAgents);
  if (!validation.valid) {
    for (const e of validation.errors) blockReasons.push(`request:${e}`);
  }

  const eligible = blockReasons.length === 0;
  return {
    eligible,
    blockReasons,
    creationRight: right,
    normalized: eligible ? validation.normalized : undefined,
    // Senior creations must be approved by admin before leaving shadow (§15).
    requiresAdminApprovalToLeaveShadow: true,
  };
}

// ── Birth certificate (§8) ──────────────────────────────────────────────────
export interface BirthCertificate {
  agentName: string;
  parentAgentKey: string | null;
  createdByAgentKey: string;
  creationReason: string;
  problemItSolves: string;
  mission: string;
  allowedTasks: string[];
  forbiddenTasks: string[];
  trainingFocus: string[];
  startingRank: "TRAINEE";
  startingAuthority: 0;
  startingMode: "SHADOW";
  riskLevel: string;
  promotionRequirement: string[];
  shutdownLearningCampRules: string;
  expectedValue: string;
  expectedSpeedCostMs: number;
}

import { UNIVERSAL_FORBIDDEN } from "../coreAgents";

/**
 * Build a §8 birth certificate from a validated spec. The certificate is
 * non-negotiable on the safety fields: TRAINEE rank, 0 authority, SHADOW mode,
 * and the universal forbidden actions are always merged in.
 */
export function buildBirthCertificate(
  spec: NormalizedAgentCreationSpec,
  opts: {
    createdByAgentKey: string;
    trainingFocus?: string[];
    riskLevel?: string;
    promotionRequirement?: string[];
    shutdownLearningCampRules?: string;
    expectedValue?: string;
    expectedSpeedCostMs?: number;
  },
): BirthCertificate {
  // Forbidden tasks are the universal hard floor — a created agent can never be
  // granted any of these regardless of its requested permissions.
  const forbidden = [...UNIVERSAL_FORBIDDEN];
  return {
    agentName: spec.proposedName,
    parentAgentKey: spec.parentAgentKey,
    createdByAgentKey: opts.createdByAgentKey,
    creationReason: spec.reasonNeeded,
    problemItSolves: spec.workflowGap,
    mission: spec.purpose,
    allowedTasks: spec.allowedOutputs.length > 0 ? spec.allowedOutputs : spec.allowedInputs,
    forbiddenTasks: forbidden,
    trainingFocus: opts.trainingFocus ?? spec.scorecard,
    startingRank: "TRAINEE",
    startingAuthority: 0,
    startingMode: "SHADOW",
    riskLevel: opts.riskLevel ?? "LOW",
    promotionRequirement: opts.promotionRequirement ?? spec.activationRequirements,
    shutdownLearningCampRules:
      opts.shutdownLearningCampRules ??
      "Repeated failure → Learning Camp (correction, not deletion). Shutdown is last resort, admin override required.",
    expectedValue: opts.expectedValue ?? "TBD — proven in shadow before any influence",
    expectedSpeedCostMs: opts.expectedSpeedCostMs ?? 0,
  };
}

// ── Parent accountability (§8) ──────────────────────────────────────────────
export type ChildOutcome = "SUCCESS" | "NOISE" | "SLOW" | "REPEATED_FAILURE";

export interface ParentAccountabilityDelta {
  leadershipPointsDelta: number;
  /** True when the parent should lose creation rights. */
  revokeCreationRights: boolean;
  reason: string;
}

/** Tie a child's outcome to its parent's leadership points (§8). */
export function parentAccountabilityDelta(outcome: ChildOutcome): ParentAccountabilityDelta {
  switch (outcome) {
    case "SUCCESS":
      return { leadershipPointsDelta: +3, revokeCreationRights: false, reason: "child_succeeded" };
    case "NOISE":
      return { leadershipPointsDelta: -2, revokeCreationRights: false, reason: "child_created_noise" };
    case "SLOW":
      return { leadershipPointsDelta: -2, revokeCreationRights: false, reason: "child_slowed_system" };
    case "REPEATED_FAILURE":
      return { leadershipPointsDelta: -4, revokeCreationRights: true, reason: "child_repeatedly_failed" };
  }
}

// ── Population report (§15) ──────────────────────────────────────────────────
export interface PopulationReport {
  byDepartment: {
    department: string;
    activeCount: number;
    traineeCount: number;
    totalCount: number;
    overActiveCap: boolean;
    overTraineeCap: boolean;
  }[];
  totalAgents: number;
  anyOverCap: boolean;
}

export function evaluatePopulation(
  agents: readonly DepartmentAgentLite[],
  limits: Partial<PopulationLimits> = {},
): PopulationReport {
  const l = { ...DEFAULT_POPULATION_LIMITS, ...limits };
  const depts = new Map<string, DepartmentAgentLite[]>();
  for (const a of agents) {
    if (!depts.has(a.department)) depts.set(a.department, []);
    depts.get(a.department)!.push(a);
  }
  const byDepartment = [...depts.entries()].map(([department, list]) => {
    const activeCount = list.filter((a) => a.currentStatus.toUpperCase() === "ACTIVE").length;
    const traineeCount = list.filter((a) => a.currentRank.toUpperCase() === "TRAINEE").length;
    return {
      department,
      activeCount,
      traineeCount,
      totalCount: list.length,
      overActiveCap: activeCount > l.maxActivePerDepartment,
      overTraineeCap: traineeCount > l.maxTraineePerDepartment,
    };
  }).sort((a, b) => a.department.localeCompare(b.department));

  return {
    byDepartment,
    totalAgents: agents.length,
    anyOverCap: byDepartment.some((d) => d.overActiveCap || d.overTraineeCap),
  };
}

// ── Cleanup recommendations (§16) ────────────────────────────────────────────
export type CleanupAction = "MERGE" | "RETIRE" | "ABSORB" | "ARCHIVE" | "QUARANTINE";

export interface CleanupCandidate {
  agentKey: string;
  name: string;
  department: string;
  isCore: boolean;
  trustScore: number;
  usefulnessScore: number;
  speedCostScore: number;
  duplicateOfAgentKey?: string | null;
  dangerous?: boolean;
  inactiveCycles?: number;
}

export interface CleanupRecommendation {
  agentKey: string;
  action: CleanupAction;
  /** For MERGE/ABSORB — the stronger target agent. */
  targetAgentKey?: string;
  reason: string;
  requiresAdmin: boolean;
}

/** Recommend §16 cleanup actions; core agents only ever get QUARANTINE. */
export function recommendCleanup(
  candidates: readonly CleanupCandidate[],
): CleanupRecommendation[] {
  const recs: CleanupRecommendation[] = [];
  for (const c of candidates) {
    if (c.dangerous) {
      recs.push({ agentKey: c.agentKey, action: "QUARANTINE", reason: "dangerous_behavior", requiresAdmin: true });
      continue;
    }
    if (c.isCore) continue; // core agents are protected from destructive cleanup
    if (c.duplicateOfAgentKey) {
      recs.push({
        agentKey: c.agentKey, action: "MERGE", targetAgentKey: c.duplicateOfAgentKey,
        reason: "duplicate_capability", requiresAdmin: true,
      });
      continue;
    }
    if (c.usefulnessScore < 25 && c.speedCostScore > 60) {
      recs.push({ agentKey: c.agentKey, action: "RETIRE", reason: "low_value_high_cost", requiresAdmin: true });
      continue;
    }
    if ((c.inactiveCycles ?? 0) > 100) {
      recs.push({ agentKey: c.agentKey, action: "ARCHIVE", reason: "long_inactive", requiresAdmin: true });
      continue;
    }
    if (c.trustScore < 35) {
      recs.push({ agentKey: c.agentKey, action: "ABSORB", reason: "weak_but_has_residual_knowledge", requiresAdmin: true });
    }
  }
  return recs;
}

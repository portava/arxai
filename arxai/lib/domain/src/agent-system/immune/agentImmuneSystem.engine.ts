// Agent Ecosystem — Layer 3 Agent Immune System (§12, §16). PURE.
//
// PURPOSE
//   Scan the agent registry for ecosystem-health anomalies (duplicates, bloat,
//   needless creation, generic repetition, agents slowing execution, pre-
//   authority influence, mission drift, recklessness, over-conservatism, low
//   value-to-speed) and recommend protective actions (quarantine, merge, retire,
//   archive, learning camp, remove creation rights, reduce authority, on-demand,
//   freeze family, recommend shutdown). Risk AI can trigger immediate restriction.
//
// SAFETY / SCOPE (inviolable):
//   - ADVISORY ONLY. Findings are RECOMMENDATIONS. Nothing here mutates an agent,
//     gates execution, or bypasses admin. Core agents are protected from
//     destructive actions (retire/merge/archive) — only softer actions apply.
//   - Risk-flagged danger is the ONE case that may be marked auto-applicable
//     (immediate restriction) — still surfaced to admin, never silent.
//   - PURE: deterministic, no I/O, no clock, no DB.

import { detectAgentDrift } from "../shadow/agentDriftDetector.engine";
import type { AgentOutputContract } from "../contracts/agentContract.types";

export type ImmuneAnomalyType =
  | "DUPLICATE_AGENT"
  | "EXCESS_CHILDREN"
  | "NEEDLESS_CREATION"
  | "GENERIC_REPETITION"
  | "SLOWING_EXECUTION"
  | "PRE_AUTHORITY_INFLUENCE"
  | "MISSION_DRIFT"
  | "RECKLESS"
  | "OVER_CONSERVATIVE"
  | "FAMILY_BLOAT"
  | "LOW_VALUE_TO_SPEED";

export type ImmuneAction =
  | "QUARANTINE"
  | "MERGE"
  | "RETIRE"
  | "ARCHIVE"
  | "LEARNING_CAMP"
  | "REMOVE_CREATION_RIGHTS"
  | "REDUCE_AUTHORITY"
  | "ON_DEMAND_ONLY"
  | "FREEZE_FAMILY"
  | "RECOMMEND_SHUTDOWN";

export type ImmuneSeverity = "LOW" | "MEDIUM" | "HIGH";

/** Registry slice the immune system inspects. */
export interface ImmuneAgentSnapshot {
  agentKey: string;
  name: string;
  department: string;
  parentAgentKey: string | null;
  currentStatus: string;
  currentRank: string;
  authorityWeight: number;
  liveInfluenceAllowed: boolean;
  isCore: boolean;
  // Rolling scores (0-100).
  trustScore: number;
  qualityScore: number;
  speedScore: number;
  protectionScore: number;
  usefulnessScore: number;
  // Health signals.
  speedCostScore: number;          // 0-100 (from speed engine)
  duplicateAnalysisRate: number;   // 0-1
  childCount: number;
  learningCampCount: number;
  /** Optional false-block / false-approval signals for recklessness/conservatism. */
  falseApprovalRate?: number;      // 0-1 (approved bad setups)
  falseBlockRate?: number;         // 0-1 (blocked good setups)
}

export interface ImmuneFinding {
  agentKey: string;
  agentName: string;
  department: string;
  anomalyType: ImmuneAnomalyType;
  severity: ImmuneSeverity;
  recommendedAction: ImmuneAction;
  /** Neutral machine reason; admin UI / Ruby humanize it. */
  reason: string;
  /** Core/destructive actions always require admin. */
  requiresAdmin: boolean;
  /** Only true for risk-flagged immediate restriction. */
  autoApplicable: boolean;
}

export interface ImmuneScanInput {
  agents: readonly ImmuneAgentSnapshot[];
  limits?: Partial<ImmunePopulationLimits>;
  /** agentKeys Risk AI has flagged as dangerous — immediate restriction. */
  riskFlaggedAgentKeys?: readonly string[];
  /** Optional drift baseline/current contract pairs for mission-drift checks. */
  driftPairs?: readonly { baseline: AgentOutputContract; current: AgentOutputContract }[];
}

export interface ImmunePopulationLimits {
  maxActivePerDepartment: number;
  maxChildrenPerParent: number;
  /** speedCostScore above this with low usefulness = low value-to-speed. */
  speedCostHigh: number;
  /** usefulnessScore below this is "low value". */
  usefulnessLow: number;
}

export const DEFAULT_IMMUNE_LIMITS: ImmunePopulationLimits = {
  maxActivePerDepartment: 6,
  maxChildrenPerParent: 5,
  speedCostHigh: 60,
  usefulnessLow: 35,
};

export interface ImmuneScanResult {
  findings: ImmuneFinding[];
  countsByType: Record<ImmuneAnomalyType, number>;
  countsBySeverity: Record<ImmuneSeverity, number>;
  /** True when at least one auto-applicable (risk) restriction is present. */
  hasImmediateRestriction: boolean;
}

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Destructive actions are blocked for core agents (downgraded to softer). */
function actionForAgent(action: ImmuneAction, isCore: boolean): ImmuneAction {
  if (!isCore) return action;
  switch (action) {
    case "RETIRE":
    case "ARCHIVE":
    case "MERGE":
    case "RECOMMEND_SHUTDOWN":
      return "LEARNING_CAMP"; // core agents are corrected, never deleted
    default:
      return action;
  }
}

export function scanEcosystemHealth(input: ImmuneScanInput): ImmuneScanResult {
  const limits = { ...DEFAULT_IMMUNE_LIMITS, ...(input.limits ?? {}) };
  const agents = input.agents;
  const riskFlagged = new Set((input.riskFlaggedAgentKeys ?? []).map((k) => k.toUpperCase()));
  const findings: ImmuneFinding[] = [];

  const push = (
    a: ImmuneAgentSnapshot,
    anomalyType: ImmuneAnomalyType,
    severity: ImmuneSeverity,
    action: ImmuneAction,
    reason: string,
    autoApplicable = false,
  ) => {
    const finalAction = actionForAgent(action, a.isCore);
    findings.push({
      agentKey: a.agentKey, agentName: a.name, department: a.department,
      anomalyType, severity, recommendedAction: finalAction, reason,
      requiresAdmin: a.isCore || finalAction === "RECOMMEND_SHUTDOWN" || !autoApplicable,
      autoApplicable,
    });
  };

  // 1) Risk-flagged danger → immediate restriction (the one auto-applicable path).
  for (const a of agents) {
    if (riskFlagged.has(a.agentKey.toUpperCase())) {
      push(a, "RECKLESS", "HIGH", "QUARANTINE", "risk_ai_flagged_dangerous", true);
    }
  }

  // 2) Duplicate agents — same normalized name OR same department + overlapping
  //    specialty with >1 active non-core member is caught as DUPLICATE/BLOAT below.
  const nameMap = new Map<string, ImmuneAgentSnapshot[]>();
  for (const a of agents) {
    const n = norm(a.name);
    if (!nameMap.has(n)) nameMap.set(n, []);
    nameMap.get(n)!.push(a);
  }
  for (const group of nameMap.values()) {
    if (group.length <= 1) continue;
    // Keep the strongest; flag the rest as duplicates to merge.
    const sorted = [...group].sort((x, y) => y.trustScore - x.trustScore || x.agentKey.localeCompare(y.agentKey));
    for (const dup of sorted.slice(1)) {
      push(dup, "DUPLICATE_AGENT", "MEDIUM", "MERGE", `duplicate_of:${sorted[0]!.agentKey}`);
    }
  }

  // 3) Per-parent / per-department population pressure.
  const childrenByParent = new Map<string, number>();
  const activeByDept = new Map<string, number>();
  for (const a of agents) {
    if (a.parentAgentKey) {
      childrenByParent.set(a.parentAgentKey, (childrenByParent.get(a.parentAgentKey) ?? 0) + 1);
    }
    if (a.currentStatus.toUpperCase() === "ACTIVE") {
      activeByDept.set(a.department, (activeByDept.get(a.department) ?? 0) + 1);
    }
  }
  for (const a of agents) {
    if (a.childCount > limits.maxChildrenPerParent) {
      push(a, "EXCESS_CHILDREN", "MEDIUM", "REMOVE_CREATION_RIGHTS",
        `children:${a.childCount}>max:${limits.maxChildrenPerParent}`);
    }
  }
  for (const [dept, count] of activeByDept) {
    if (count > limits.maxActivePerDepartment) {
      // Flag the weakest non-core members in the bloated department.
      const members = agents
        .filter((a) => a.department === dept && a.currentStatus.toUpperCase() === "ACTIVE" && !a.isCore)
        .sort((x, y) => x.usefulnessScore - y.usefulnessScore);
      for (const weak of members.slice(0, Math.max(0, count - limits.maxActivePerDepartment))) {
        push(weak, "FAMILY_BLOAT", "MEDIUM", "RETIRE", `department_bloat:${dept}:${count}`);
      }
    }
  }

  // 4) Per-agent behavioral anomalies.
  for (const a of agents) {
    const lowUsefulness = a.usefulnessScore < limits.usefulnessLow;
    const slow = a.speedCostScore >= limits.speedCostHigh;

    // Slowing execution.
    if (slow) {
      push(a, "SLOWING_EXECUTION", lowUsefulness ? "HIGH" : "MEDIUM",
        lowUsefulness ? "ON_DEMAND_ONLY" : "ON_DEMAND_ONLY",
        `speed_cost:${a.speedCostScore.toFixed(0)}`);
    }
    // Low value-to-speed (slow AND low usefulness).
    if (slow && lowUsefulness) {
      push(a, "LOW_VALUE_TO_SPEED", "HIGH", "RETIRE",
        `low_value_to_speed:useful=${a.usefulnessScore.toFixed(0)},speedCost=${a.speedCostScore.toFixed(0)}`);
    }
    // Generic repetition (high duplicate rate without slowness).
    if (a.duplicateAnalysisRate >= 0.5 && !slow) {
      push(a, "GENERIC_REPETITION", "LOW", "ON_DEMAND_ONLY",
        `duplicate_rate:${a.duplicateAnalysisRate.toFixed(2)}`);
    }
    // Pre-authority influence: a shadow/0-authority agent that is somehow marked
    // live-influence-allowed (should never happen — strong signal of misconfig).
    if (a.authorityWeight <= 0 && a.liveInfluenceAllowed) {
      push(a, "PRE_AUTHORITY_INFLUENCE", "HIGH", "REDUCE_AUTHORITY",
        "zero_authority_but_live_influence_allowed");
    }
    // Reckless: approves bad setups repeatedly (low protection + high false-approval).
    if ((a.falseApprovalRate ?? 0) >= 0.4 && a.protectionScore < 40) {
      push(a, "RECKLESS", "HIGH", "LEARNING_CAMP",
        `false_approval_rate:${(a.falseApprovalRate ?? 0).toFixed(2)}`);
    }
    // Over-conservative: blocks good setups repeatedly with no protective value.
    if ((a.falseBlockRate ?? 0) >= 0.5 && a.usefulnessScore < limits.usefulnessLow) {
      push(a, "OVER_CONSERVATIVE", "MEDIUM", "LEARNING_CAMP",
        `false_block_rate:${(a.falseBlockRate ?? 0).toFixed(2)}`);
    }
    // Needless creation: created child agents while itself underperforming.
    if (a.childCount > 0 && a.trustScore < 40) {
      push(a, "NEEDLESS_CREATION", "MEDIUM", "REMOVE_CREATION_RIGHTS",
        `created_children_while_trust_low:${a.trustScore.toFixed(0)}`);
    }
  }

  // 5) Mission drift via the reused drift detector.
  for (const pair of input.driftPairs ?? []) {
    const report = detectAgentDrift(pair.baseline, pair.current);
    if (report.drifted && (report.severity === "HIGH" || report.severity === "MEDIUM")) {
      const a = agents.find((x) => x.agentKey === report.agentId || x.name === report.agentName);
      if (a) {
        push(a, "MISSION_DRIFT", report.severity === "HIGH" ? "HIGH" : "MEDIUM",
          "LEARNING_CAMP", `drift:${report.reasons.join("; ")}`);
      }
    }
  }

  // Aggregate counts.
  const countsByType = {
    DUPLICATE_AGENT: 0, EXCESS_CHILDREN: 0, NEEDLESS_CREATION: 0, GENERIC_REPETITION: 0,
    SLOWING_EXECUTION: 0, PRE_AUTHORITY_INFLUENCE: 0, MISSION_DRIFT: 0, RECKLESS: 0,
    OVER_CONSERVATIVE: 0, FAMILY_BLOAT: 0, LOW_VALUE_TO_SPEED: 0,
  } as Record<ImmuneAnomalyType, number>;
  const countsBySeverity = { LOW: 0, MEDIUM: 0, HIGH: 0 } as Record<ImmuneSeverity, number>;
  for (const f of findings) {
    countsByType[f.anomalyType] += 1;
    countsBySeverity[f.severity] += 1;
  }

  return {
    findings,
    countsByType,
    countsBySeverity,
    hasImmediateRestriction: findings.some((f) => f.autoApplicable),
  };
}

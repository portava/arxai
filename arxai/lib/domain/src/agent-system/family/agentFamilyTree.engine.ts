// Agent Ecosystem — Layer 3 Agent Family Tree / Departments (§9). PURE.
//
// PURPOSE
//   Build the Ruby-Household → Department → child-agents tree from the registry,
//   summarize each department (score, strongest/weakest child, speed cost,
//   usefulness, Learning Camp count, bloat risk), and compute parent
//   accountability roll-ups for the admin family-tree view.
//
// SAFETY / SCOPE (inviolable):
//   - VISIBILITY / ANALYTICS ONLY. Nothing here gates execution or mutates an
//     agent. Department scores influence ranking/visibility only.
//   - PURE: deterministic, no I/O, no clock, no DB.

// Canonical departments under the Ruby Household (§9).
export const DEPARTMENTS = [
  "MARKET_STRUCTURE",
  "SCALP",
  "RISK",
  "ENTRY",
  "EXIT",
  "SCANNER",
  "REVIEW",
  "EXECUTION",
  "AGENT_OPERATIONS",
] as const;
export type Department = (typeof DEPARTMENTS)[number];

/** Registry slice the tree builder reads. */
export interface FamilyAgentSnapshot {
  agentKey: string;
  name: string;
  department: string;
  parentAgentKey: string | null;
  currentRank: string;
  currentStatus: string;
  isCore: boolean;
  trustScore: number;
  usefulnessScore: number;
  speedScore: number;
  speedCostScore: number;  // 0-100, higher = more expensive
  learningCampCount: number;
}

export interface FamilyTreeNode {
  agentKey: string;
  name: string;
  department: string;
  rank: string;
  status: string;
  isCore: boolean;
  children: FamilyTreeNode[];
}

export interface DepartmentSummary {
  department: string;
  agentCount: number;
  /** Average trust*usefulness composite (0-100). */
  departmentScore: number;
  strongestChildKey: string | null;
  weakestChildKey: string | null;
  /** Average speedCostScore across the department (0-100). */
  departmentSpeedCost: number;
  /** Average usefulnessScore across the department (0-100). */
  departmentUsefulness: number;
  learningCampCount: number;
  /** True when the department looks bloated (many low-value members). */
  bloatRisk: boolean;
}

export interface ParentAccountabilitySummary {
  parentAgentKey: string;
  parentName: string;
  childCount: number;
  /** Average child usefulness (0-100) — the parent's leadership signal. */
  avgChildUsefulness: number;
  strongestChildKey: string | null;
  weakestChildKey: string | null;
  /** True when the parent's children are dragging (low avg usefulness). */
  underperformingChildren: boolean;
}

export interface FamilyTree {
  rootKey: string;
  root: FamilyTreeNode | null;
  departments: DepartmentSummary[];
  parentAccountability: ParentAccountabilitySummary[];
}

const ROOT_KEY = "RUBY";
const BLOAT_USEFULNESS_FLOOR = 35;

function buildNode(
  agent: FamilyAgentSnapshot,
  childrenByParent: Map<string, FamilyAgentSnapshot[]>,
  seen: Set<string>,
): FamilyTreeNode {
  seen.add(agent.agentKey);
  const kids = (childrenByParent.get(agent.agentKey) ?? [])
    .filter((c) => !seen.has(c.agentKey))
    .sort((a, b) => a.agentKey.localeCompare(b.agentKey));
  return {
    agentKey: agent.agentKey,
    name: agent.name,
    department: agent.department,
    rank: agent.currentRank,
    status: agent.currentStatus,
    isCore: agent.isCore,
    children: kids.map((k) => buildNode(k, childrenByParent, seen)),
  };
}

export function buildFamilyTree(agents: readonly FamilyAgentSnapshot[]): FamilyTree {
  const byKey = new Map(agents.map((a) => [a.agentKey, a]));
  const childrenByParent = new Map<string, FamilyAgentSnapshot[]>();
  for (const a of agents) {
    if (a.parentAgentKey) {
      if (!childrenByParent.has(a.parentAgentKey)) childrenByParent.set(a.parentAgentKey, []);
      childrenByParent.get(a.parentAgentKey)!.push(a);
    }
  }

  const rootAgent = byKey.get(ROOT_KEY) ?? null;
  const root = rootAgent ? buildNode(rootAgent, childrenByParent, new Set<string>()) : null;

  // Department summaries.
  const departments: DepartmentSummary[] = [];
  const deptMap = new Map<string, FamilyAgentSnapshot[]>();
  for (const a of agents) {
    if (!deptMap.has(a.department)) deptMap.set(a.department, []);
    deptMap.get(a.department)!.push(a);
  }
  for (const [department, list] of [...deptMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    departments.push(summarizeDepartment(department, list));
  }

  // Parent accountability roll-ups.
  const parentAccountability: ParentAccountabilitySummary[] = [];
  for (const [parentKey, kids] of [...childrenByParent.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const parent = byKey.get(parentKey);
    const avgChildUsefulness = avg(kids.map((k) => k.usefulnessScore));
    const strongest = pickExtreme(kids, "usefulnessScore", "max");
    const weakest = pickExtreme(kids, "usefulnessScore", "min");
    parentAccountability.push({
      parentAgentKey: parentKey,
      parentName: parent?.name ?? parentKey,
      childCount: kids.length,
      avgChildUsefulness: +avgChildUsefulness.toFixed(2),
      strongestChildKey: strongest?.agentKey ?? null,
      weakestChildKey: weakest?.agentKey ?? null,
      underperformingChildren: avgChildUsefulness < BLOAT_USEFULNESS_FLOOR,
    });
  }

  return { rootKey: ROOT_KEY, root, departments, parentAccountability };
}

export function summarizeDepartment(
  department: string,
  members: readonly FamilyAgentSnapshot[],
): DepartmentSummary {
  const departmentScore = +avg(members.map((m) => (m.trustScore + m.usefulnessScore) / 2)).toFixed(2);
  const strongest = pickExtreme(members, "usefulnessScore", "max");
  const weakest = pickExtreme(members, "usefulnessScore", "min");
  const departmentSpeedCost = +avg(members.map((m) => m.speedCostScore)).toFixed(2);
  const departmentUsefulness = +avg(members.map((m) => m.usefulnessScore)).toFixed(2);
  const learningCampCount = members.reduce((s, m) => s + m.learningCampCount, 0);
  const lowValueCount = members.filter((m) => m.usefulnessScore < BLOAT_USEFULNESS_FLOOR).length;
  const bloatRisk = members.length >= 4 && lowValueCount / members.length >= 0.5;
  return {
    department,
    agentCount: members.length,
    departmentScore,
    strongestChildKey: strongest?.agentKey ?? null,
    weakestChildKey: weakest?.agentKey ?? null,
    departmentSpeedCost,
    departmentUsefulness,
    learningCampCount,
    bloatRisk,
  };
}

function avg(nums: readonly number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((s, n) => s + n, 0) / nums.length;
}

function pickExtreme(
  list: readonly FamilyAgentSnapshot[],
  field: "usefulnessScore",
  kind: "max" | "min",
): FamilyAgentSnapshot | null {
  if (list.length === 0) return null;
  return [...list].sort((a, b) =>
    kind === "max" ? b[field] - a[field] || a.agentKey.localeCompare(b.agentKey)
                   : a[field] - b[field] || a.agentKey.localeCompare(b.agentKey),
  )[0]!;
}

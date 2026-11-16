// Agent Ecosystem — Layer 3 Governed Agent Factory + population unit tests
// (PURE, no DB). Covers spec test cases 15-17:
//   15. A qualified parent (rank + trust + clearances) CAN create a child.
//   16. A duplicate child (same name as an existing agent) is BLOCKED.
//   17. A low-score / under-ranked parent CANNOT create a child.
// Plus the inviolable defaults: creation rights are rank-gated and every minted
// child is forced SHADOW / 0 authority. Nothing here is an execution gate.
//
// Run: pnpm --filter @workspace/scripts run test:agent-factory-population

import {
  creationRightForRank,
  evaluateCreationEligibility,
  type AgentCreationRequestInput,
  type CreationEligibilityInput,
  type DepartmentAgentLite,
  type ParentAgentContext,
} from "@workspace/domain/agent-system";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) { console.log(`  PASS  ${name}`); }
  else { console.error(`  FAIL  ${name}`); failures++; }
}

console.log("Agent factory + population test");

function validRequest(over: Partial<AgentCreationRequestInput> = {}): AgentCreationRequestInput {
  return {
    proposedName: "Range Breakout Specialist",
    proposedDepartment: "ENTRY",
    purpose: "Detect range breakouts on the 5m for scalp entries",
    reasonNeeded: "Repeated missed breakout entries in ranging conditions",
    workflowGap: "No agent specializes in breakout-from-range timing",
    allowedInputs: ["candles", "atr"],
    allowedOutputs: ["entry_signal"],
    permissions: ["read_candles"],
    failureConditions: ["false_breakout_rate>40%"],
    scorecard: ["win_rate", "false_breakout_rate"],
    testingRequirements: ["shadow_for_30_days"],
    activationRequirements: ["admin_review"],
    parentAgentKey: "PRECISION",
    ...over,
  };
}

function parent(over: Partial<ParentAgentContext> = {}): ParentAgentContext {
  return {
    agentKey: "PRECISION", name: "Entry Timing AI", rank: "SENIOR",
    trustScore: 85, canCreateAgents: true, childCount: 0, ...over,
  };
}

function eligibilityInput(over: Partial<CreationEligibilityInput> = {}): CreationEligibilityInput {
  return {
    request: validRequest(),
    parent: parent(),
    existingAgents: [],
    immuneApproved: true,
    riskClear: true,
    taskGapEvidenceCount: 3,
    missingSpecialty: true,
    ...over,
  };
}

// Creation rights are strictly rank-gated.
check("TRAINEE has no creation right", creationRightForRank("TRAINEE") === "NONE");
check("ANALYST may only request", creationRightForRank("ANALYST") === "REQUEST");
check("SENIOR may create shadow", creationRightForRank("SENIOR") === "CREATE_SHADOW");
check("LEAD may create+supervise", creationRightForRank("LEAD") === "CREATE_SUPERVISE");

// 15. Qualified parent can create a child.
{
  const r = evaluateCreationEligibility(eligibilityInput());
  check("15: qualified senior is eligible", r.eligible === true);
  check("15: no block reasons when eligible", r.blockReasons.length === 0);
  check("15: minted child is forced SHADOW", r.normalized?.startingStatus === "SHADOW");
  check("15: minted child has 0 authority", r.normalized?.authorityWeight === 0);
  check("15: minted child has no live influence", r.normalized?.liveInfluenceAllowed === false);
  check("15: senior creation still needs admin to leave shadow", r.requiresAdminApprovalToLeaveShadow === true);
}

// 16. Duplicate child (same name as an existing agent) is blocked.
{
  const existing: DepartmentAgentLite[] = [
    { agentKey: "DUP", name: "Range Breakout Specialist", department: "ENTRY", currentRank: "JUNIOR", currentStatus: "ACTIVE" },
  ];
  const r = evaluateCreationEligibility(eligibilityInput({ existingAgents: existing }));
  check("16: duplicate name blocks creation", r.eligible === false);
  check("16: duplicate surfaces a request:duplicate_agent_name reason",
    r.blockReasons.some((b) => b.startsWith("request:duplicate_agent_name")));
}

// 17a. Under-ranked parent (ANALYST) cannot create — rank gate.
{
  const r = evaluateCreationEligibility(eligibilityInput({ parent: parent({ rank: "ANALYST" }) }));
  check("17: analyst lacks creation right => blocked", r.eligible === false);
  check("17: insufficient_creation_right reason present",
    r.blockReasons.some((b) => b.startsWith("insufficient_creation_right")));
}

// 17b. Low-trust parent cannot create — trust gate.
{
  const r = evaluateCreationEligibility(eligibilityInput({ parent: parent({ trustScore: 40 }) }));
  check("17: low-trust parent => blocked", r.eligible === false);
  check("17: parent_trust_too_low reason present",
    r.blockReasons.some((b) => b.startsWith("parent_trust_too_low")));
}

// Default-deny: missing task-gap / specialty evidence blocks even a strong parent.
{
  const r = evaluateCreationEligibility(eligibilityInput({ taskGapEvidenceCount: 0, missingSpecialty: false }));
  check("default-deny: no evidence => blocked", r.eligible === false);
  check("default-deny: no_repeated_task_gap_evidence reason", r.blockReasons.includes("no_repeated_task_gap_evidence"));
  check("default-deny: specialty_already_covered reason", r.blockReasons.includes("specialty_already_covered"));
}

if (failures > 0) {
  console.error(`\nAgent factory + population test: ${failures} FAILED`);
  process.exit(1);
}
console.log("\nAgent factory + population test: ALL PASS");
export {};

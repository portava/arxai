// Agent Ecosystem — Layer 3 Immune System unit tests (PURE, no DB).
// Covers spec test case 22: the Immune System detects duplicate / slow / useless
// agents (and the other ecosystem-health anomalies), recommends actions, and —
// only for Risk-flagged danger — marks a finding auto-applicable. Core agents
// are corrected (LEARNING_CAMP), never deleted. Nothing here gates execution.
//
// Run: pnpm --filter @workspace/scripts run test:agent-immune

import {
  scanEcosystemHealth,
  type ImmuneAgentSnapshot,
} from "@workspace/domain/agent-system";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) { console.log(`  PASS  ${name}`); }
  else { console.error(`  FAIL  ${name}`); failures++; }
}

console.log("Agent immune system test");

function agent(over: Partial<ImmuneAgentSnapshot> = {}): ImmuneAgentSnapshot {
  return {
    agentKey: "A", name: "Agent A", department: "ENTRY",
    parentAgentKey: null, currentStatus: "ACTIVE", currentRank: "ANALYST",
    authorityWeight: 0.3, liveInfluenceAllowed: false, isCore: false,
    trustScore: 70, qualityScore: 70, speedScore: 70, protectionScore: 70, usefulnessScore: 70,
    speedCostScore: 10, duplicateAnalysisRate: 0, childCount: 0, learningCampCount: 0,
    ...over,
  };
}

// 22a. Two agents with the same name => a DUPLICATE_AGENT (merge) is detected.
{
  const r = scanEcosystemHealth({
    agents: [
      agent({ agentKey: "DUP_A", name: "Range Breakout AI", authorityWeight: 0.5 }),
      agent({ agentKey: "DUP_B", name: "Range Breakout AI", authorityWeight: 0.2 }),
    ],
  });
  check("22: duplicate (same-name) agent flagged", r.findings.some((f) => f.anomalyType === "DUPLICATE_AGENT"));
}

// 22a'. A single agent with a high duplicate-analysis rate => GENERIC_REPETITION.
{
  const r = scanEcosystemHealth({
    agents: [agent({ agentKey: "REPEAT", duplicateAnalysisRate: 0.8 })],
  });
  check("22: repetitive agent flagged", r.findings.some((f) => f.anomalyType === "GENERIC_REPETITION"));
}

// 22b. A slow, execution-slowing agent is detected.
{
  const r = scanEcosystemHealth({
    agents: [agent({ agentKey: "SLOW", speedCostScore: 85, liveInfluenceAllowed: true })],
  });
  check("22: slow agent flagged", r.findings.some((f) => f.anomalyType === "SLOWING_EXECUTION"));
}

// 22c. A low-value-to-speed (useless) agent is detected.
{
  const r = scanEcosystemHealth({
    agents: [agent({ agentKey: "USELESS", usefulnessScore: 5, speedCostScore: 70 })],
  });
  check("22: useless (low value-to-speed) agent flagged",
    r.findings.some((f) => f.anomalyType === "LOW_VALUE_TO_SPEED" || f.anomalyType === "GENERIC_REPETITION"));
}

// 22d. Risk-flagged danger => immediate, auto-applicable restriction.
{
  const r = scanEcosystemHealth({
    agents: [agent({ agentKey: "DANGER" })],
    riskFlaggedAgentKeys: ["DANGER"],
  });
  check("22: risk-flagged agent has a finding", r.findings.some((f) => f.agentKey === "DANGER"));
  check("22: risk-flagged finding is auto-applicable",
    r.findings.some((f) => f.agentKey === "DANGER" && f.autoApplicable === true));
  check("22: scan reports an immediate restriction", r.hasImmediateRestriction === true);
}

// 22e. Pre-authority live influence (shadow agent influencing live) is detected.
{
  const r = scanEcosystemHealth({
    agents: [agent({ agentKey: "PREMATURE", currentStatus: "SHADOW", authorityWeight: 0, liveInfluenceAllowed: true })],
  });
  check("22: premature live influence flagged",
    r.findings.some((f) => f.anomalyType === "PRE_AUTHORITY_INFLUENCE"));
}

// Core agents are corrected, never deleted: destructive actions downgrade.
{
  const r = scanEcosystemHealth({
    agents: [agent({ agentKey: "CORE", isCore: true, duplicateAnalysisRate: 0.9 })],
    riskFlaggedAgentKeys: ["CORE"],
  });
  const coreFindings = r.findings.filter((f) => f.agentKey === "CORE");
  check("core agent never gets a destructive action",
    coreFindings.every((f) => !["RETIRE", "ARCHIVE", "MERGE", "RECOMMEND_SHUTDOWN"].includes(f.recommendedAction)));
}

// A healthy roster produces no findings and no immediate restriction.
{
  const r = scanEcosystemHealth({ agents: [agent({ agentKey: "HEALTHY" })] });
  check("healthy agent => no findings", r.findings.length === 0);
  check("healthy scan => no immediate restriction", r.hasImmediateRestriction === false);
}

if (failures > 0) {
  console.error(`\nAgent immune system test: ${failures} FAILED`);
  process.exit(1);
}
console.log("\nAgent immune system test: ALL PASS");
export {};

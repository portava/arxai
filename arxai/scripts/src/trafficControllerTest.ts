// Agent Ecosystem — Layer 3 Traffic Controller unit tests (PURE, no DB).
// Verifies speed-protection participant selection: only surface-relevant agents
// are considered; HIGH importance runs everyone relevant, LOW importance caps to
// the most influential few; operations agents only join HIGH decisions; the
// summary honestly reports whether participation was limited.
//
// Run: pnpm --filter @workspace/scripts run test:traffic-controller

import {
  selectParticipants,
  type AdvisoryAgentSnapshot,
} from "@workspace/domain/agent-system";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) { console.log(`  PASS  ${name}`); }
  else { console.error(`  FAIL  ${name}`); failures++; }
}

console.log("Traffic Controller test");

function agent(over: Partial<AdvisoryAgentSnapshot> = {}): AdvisoryAgentSnapshot {
  return {
    agentKey: "STRUCT", name: "Market Structure AI", department: "MARKET_STRUCTURE",
    trustScore: 80, authorityWeight: 0.2, currentStatus: "ACTIVE", ...over,
  };
}

const eff = (a: AdvisoryAgentSnapshot) =>
  a.currentStatus === "ACTIVE" ? a.authorityWeight : 0;

const roster: AdvisoryAgentSnapshot[] = [
  agent({ agentKey: "STRUCT", department: "MARKET_STRUCTURE", authorityWeight: 0.18 }),
  agent({ agentKey: "RISK", department: "RISK", authorityWeight: 0.2 }),
  agent({ agentKey: "PRECISION", department: "ENTRY", authorityWeight: 0.12 }),
  agent({ agentKey: "EXEC", department: "EXECUTION", authorityWeight: 0.12 }),
  agent({ agentKey: "SCALP_AI", department: "SCALP", authorityWeight: 0, currentStatus: "SHADOW" }),
  agent({ agentKey: "EXIT_TP_AI", department: "EXIT", authorityWeight: 0, currentStatus: "SHADOW" }),
  agent({ agentKey: "TRAFFIC_CONTROLLER", department: "AGENT_OPERATIONS", authorityWeight: 0, currentStatus: "SHADOW" }),
];

// 1. Irrelevant departments are excluded from a SCALP review.
{
  const r = selectParticipants({ surface: "SCALP", importance: "HIGH", agents: roster, effectiveInfluence: eff });
  const depts = new Set(r.participants.map((p) => p.department));
  check("scalp review excludes market-structure", !depts.has("MARKET_STRUCTURE"));
  check("scalp review includes SCALP + RISK", depts.has("SCALP") && depts.has("RISK"));
}

// 2. Operations agents only join HIGH importance.
{
  const high = selectParticipants({ surface: "SCANNER", importance: "HIGH", agents: roster, effectiveInfluence: eff });
  const low = selectParticipants({ surface: "SCANNER", importance: "LOW", agents: roster, effectiveInfluence: eff });
  check("HIGH considers operations agents", high.participants.some((p) => p.department === "AGENT_OPERATIONS"));
  check("LOW excludes operations agents", !low.participants.some((p) => p.department === "AGENT_OPERATIONS"));
}

// 3. LOW importance caps participation; HIGH does not.
{
  const high = selectParticipants({ surface: "SCANNER", importance: "HIGH", agents: roster, effectiveInfluence: eff });
  const low = selectParticipants({ surface: "SCANNER", importance: "LOW", agents: roster, effectiveInfluence: eff });
  check("LOW participation is capped to 3", low.participants.length <= 3);
  check("LOW is reported as limited", low.summary.limited === true);
  check("HIGH includes more agents than LOW", high.participants.length > low.participants.length);
}

// 4. Capping keeps the most influential agents first.
{
  const low = selectParticipants({ surface: "SCANNER", importance: "LOW", agents: roster, effectiveInfluence: eff });
  check("most influential (RISK 0.20) survives the cap", low.participants.some((p) => p.agentKey === "RISK"));
  check("a zero-influence shadow agent is dropped first", !low.participants.some((p) => p.agentKey === "SCALP_AI"));
}

// 5. Summary counts are consistent.
{
  const r = selectParticipants({ surface: "SCANNER", importance: "MEDIUM", agents: roster, effectiveInfluence: eff });
  check("participated <= considered", r.summary.participatedCount <= r.summary.consideredCount);
  check("participated count matches array", r.summary.participatedCount === r.participants.length);
}

// 6. Determinism.
{
  const input = { surface: "SCANNER", importance: "HIGH" as const, agents: roster, effectiveInfluence: eff };
  const a = selectParticipants(input);
  const b = selectParticipants(input);
  check("selection is deterministic", JSON.stringify(a.participants.map((p) => p.agentKey)) === JSON.stringify(b.participants.map((p) => p.agentKey)));
}

if (failures > 0) {
  console.error(`\nTraffic Controller test: ${failures} FAILED`);
  process.exit(1);
}
console.log("\nTraffic Controller test: ALL PASS");
export {};

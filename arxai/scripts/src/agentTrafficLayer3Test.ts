// Agent Ecosystem — Layer 3 Traffic Controller unit tests (PURE, no DB).
// Covers spec test cases 18-19:
//   18. Scalp Mode runs only the scalp-critical set; everyone else steps back.
//   19. Live Execution Mode runs only execution-critical agents and bypasses
//       deep analysis (execution always gets priority; the ecosystem never adds
//       meaningful latency to the proven execution path).
//
// Run: pnpm --filter @workspace/scripts run test:agent-traffic-layer3

import {
  routeAgents,
  type TrafficAgentSnapshot,
} from "@workspace/domain/agent-system";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) { console.log(`  PASS  ${name}`); }
  else { console.error(`  FAIL  ${name}`); failures++; }
}

console.log("Agent traffic controller (Layer 3) test");

// A representative slice of the desk across departments.
const ROSTER: TrafficAgentSnapshot[] = [
  { agentKey: "EXEC", name: "Execution AI", department: "EXECUTION", currentStatus: "ACTIVE", authorityWeight: 0.9 },
  { agentKey: "RISK", name: "Risk AI", department: "RISK", currentStatus: "ACTIVE", authorityWeight: 0.9 },
  { agentKey: "SCALP", name: "Scalp AI", department: "SCALP", currentStatus: "ACTIVE", authorityWeight: 0.6 },
  { agentKey: "ENTRY", name: "Entry Timing AI", department: "ENTRY", currentStatus: "ACTIVE", authorityWeight: 0.5 },
  { agentKey: "EXIT", name: "Exit AI", department: "EXIT", currentStatus: "ACTIVE", authorityWeight: 0.5 },
  { agentKey: "STRUCT", name: "Market Structure AI", department: "MARKET_STRUCTURE", currentStatus: "ACTIVE", authorityWeight: 0.5 },
  { agentKey: "SCANNER", name: "Scanner AI", department: "SCANNER", currentStatus: "ACTIVE", authorityWeight: 0.5 },
  { agentKey: "REVIEW", name: "Trade Review AI", department: "REVIEW", currentStatus: "ACTIVE", authorityWeight: 0.4 },
  { agentKey: "RUBY", name: "Ruby", department: "RUBY_HOUSEHOLD", currentStatus: "ACTIVE", authorityWeight: 0.5 },
  { agentKey: "FACTORY", name: "Agent Factory", department: "AGENT_OPERATIONS", currentStatus: "ACTIVE", authorityWeight: 0.3 },
];

function participating(r: ReturnType<typeof routeAgents>): Set<string> {
  return new Set(r.decisions.filter((d) => d.participating).map((d) => d.department));
}

// 18. Scalp Mode limits agents to the scalp-critical set.
{
  const r = routeAgents({ mode: "SCALP", agents: ROSTER });
  const parts = participating(r);
  check("18: scalp runs SCALP", parts.has("SCALP"));
  check("18: scalp runs RISK", parts.has("RISK"));
  check("18: scalp runs ENTRY", parts.has("ENTRY"));
  check("18: scalp runs EXIT", parts.has("EXIT"));
  check("18: scalp does NOT run SCANNER", !parts.has("SCANNER"));
  check("18: scalp does NOT run REVIEW", !parts.has("REVIEW"));
  check("18: scalp steps non-critical agents off the hot path",
    r.decisions.some((d) => !d.participating));
  check("18: scalp participating count < roster", r.participatingCount < ROSTER.length);
  check("18: scalp latency budget is tight", r.latencyBudgetMs <= 150);
}

// 19. Live Execution Mode runs ONLY execution-critical agents and bypasses deep
//     analysis — execution always gets priority.
{
  const r = routeAgents({ mode: "LIVE_EXECUTION", agents: ROSTER, tradeActionInvolved: true });
  const parts = participating(r);
  check("19: live runs EXECUTION", parts.has("EXECUTION"));
  check("19: live runs RISK", parts.has("RISK"));
  check("19: live does NOT run SCANNER", !parts.has("SCANNER"));
  check("19: live does NOT run SCALP", !parts.has("SCALP"));
  check("19: live does NOT run RUBY_HOUSEHOLD", !parts.has("RUBY_HOUSEHOLD"));
  check("19: live sets executionPriority", r.executionPriority === true);
  check("19: live bypasses deep analysis", r.bypassDeepAnalysis === true);
  check("19: live latency budget is tiny", r.latencyBudgetMs <= 50);
  check("19: only execution-critical departments participate", parts.size <= 2);
}

// Emergency bypasses ALL nonessential analysis regardless of mode.
{
  const r = routeAgents({ mode: "SCANNER", agents: ROSTER, emergency: true });
  check("emergency bypasses deep analysis", r.bypassDeepAnalysis === true);
  check("emergency keeps execution priority", r.executionPriority === true);
}

// Determinism.
{
  const a = routeAgents({ mode: "SCALP", agents: ROSTER });
  const b = routeAgents({ mode: "SCALP", agents: ROSTER });
  check("traffic routing is deterministic", JSON.stringify(a) === JSON.stringify(b));
}

if (failures > 0) {
  console.error(`\nAgent traffic controller (Layer 3) test: ${failures} FAILED`);
  process.exit(1);
}
console.log("\nAgent traffic controller (Layer 3) test: ALL PASS");
export {};

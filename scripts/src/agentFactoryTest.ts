// Agent Ecosystem — Layer 3 Governed Agent Factory unit tests (PURE, no DB).
// Verifies the inviolable creation gates: under-specified requests are rejected;
// a request asking for ANY universally-forbidden permission is rejected; a
// duplicate name is rejected; and a valid request is NORMALIZED to a Shadow-Mode,
// 0% authority, no-live-influence spec that the caller cannot override.
//
// Run: pnpm --filter @workspace/scripts run test:agent-factory

import {
  validateAgentCreationRequest,
  type AgentCreationRequestInput,
  type ExistingAgentLite,
} from "@workspace/domain/agent-system";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) { console.log(`  PASS  ${name}`); }
  else { console.error(`  FAIL  ${name}`); failures++; }
}

console.log("Agent Factory validator test");

function goodReq(over: Partial<AgentCreationRequestInput> = {}): AgentCreationRequestInput {
  return {
    proposedName: "Sentiment Watch AI",
    proposedDepartment: "NEWS",
    purpose: "Watch high-impact news and flag setups that fight the headline.",
    reasonNeeded: "Repeated losses on technically-good setups during news spikes.",
    workflowGap: "No agent currently owns current-event risk.",
    allowedInputs: ["economic_calendar", "headline_feed"],
    allowedOutputs: ["news_risk_flag"],
    permissions: ["read_market_data", "emit_advisory_flag"],
    failureConditions: ["misses a red-folder event"],
    scorecard: ["news_flag_precision"],
    testingRequirements: ["shadow_for_30_days"],
    activationRequirements: ["promotion_board_approval"],
    ...over,
  };
}

const existing: ExistingAgentLite[] = [
  { agentKey: "RISK", name: "Risk AI", department: "RISK" },
  { agentKey: "STRUCT", name: "Market Structure AI", department: "MARKET_STRUCTURE" },
];

// 1. A complete, safe request validates and normalizes to shadow defaults.
{
  const r = validateAgentCreationRequest(goodReq(), existing);
  check("valid request passes", r.valid === true);
  check("normalized is present", !!r.normalized);
  check("born SHADOW status", r.normalized?.startingStatus === "SHADOW");
  check("born 0 authority", r.normalized?.authorityWeight === 0);
  check("no live influence", r.normalized?.liveInfluenceAllowed === false);
  check("cannot create agents", r.normalized?.canCreateAgents === false);
}

// 2. Missing required text field => rejected.
{
  const r = validateAgentCreationRequest(goodReq({ purpose: "" }), existing);
  check("missing purpose rejected", r.valid === false);
  check("error names the field", r.errors.some((e) => e.includes("purpose")));
}

// 3. Missing required list field => rejected.
{
  const r = validateAgentCreationRequest(goodReq({ scorecard: [] }), existing);
  check("missing scorecard rejected", r.valid === false);
  check("error names scorecard", r.errors.some((e) => e.includes("scorecard")));
}

// 4. Requesting a forbidden permission => rejected (any spelling/casing).
{
  const r1 = validateAgentCreationRequest(goodReq({ permissions: ["read_market_data", "place_trade"] }), existing);
  check("place_trade rejected", r1.valid === false && r1.errors.some((e) => e.startsWith("forbidden_permission:place_trade")));
  const r2 = validateAgentCreationRequest(goodReq({ permissions: ["Bypass Safety Gate"] }), existing);
  check("forbidden permission caught regardless of spelling", r2.valid === false && r2.errors.some((e) => e.startsWith("forbidden_permission:bypass_safety_gate")));
}

// 5. Duplicate name (case-insensitive) => rejected.
{
  const r = validateAgentCreationRequest(goodReq({ proposedName: "  risk ai " }), existing);
  check("duplicate name rejected", r.valid === false && r.errors.some((e) => e.startsWith("duplicate_agent_name:")));
}

// 6. Caller-supplied authority is ignored — normalization forces shadow.
{
  const sneaky = { ...goodReq(), authorityWeight: 1, liveInfluenceAllowed: true, startingStatus: "ACTIVE" } as unknown as AgentCreationRequestInput;
  const r = validateAgentCreationRequest(sneaky, existing);
  check("sneaky authority is forced back to 0", r.normalized?.authorityWeight === 0);
  check("sneaky live influence is forced false", r.normalized?.liveInfluenceAllowed === false);
  check("sneaky status is forced SHADOW", r.normalized?.startingStatus === "SHADOW");
}

// 7. No existing-agent list still validates a clean request.
{
  const r = validateAgentCreationRequest(goodReq());
  check("validates without an existing roster", r.valid === true);
}

if (failures > 0) {
  console.error(`\nAgent Factory validator test: ${failures} FAILED`);
  process.exit(1);
}
console.log("\nAgent Factory validator test: ALL PASS");
export {};

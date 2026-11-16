// Agent Ecosystem — Layer 3 Traffic Controller ENFORCEMENT unit tests (PURE, no DB).
//
// Phase 4 proof that the Traffic Controller's participant selection is FUNCTIONAL,
// not decorative: when `allowedAgentKeys` is supplied to the Court, an agent the
// controller did NOT select steps back entirely — it forms no voting position and
// raises no challenge — while the same fixture WITHOUT the allow-list still lets
// that agent vote (fail-open / legacy behaviour). Enforcement can only REMOVE
// influence, so the governed score stays protective (<= advisory) and the live
// path is never touched (this engine is pure and advisory-only).
//
// Run: pnpm --filter @workspace/scripts run test:agent-traffic-enforcement

import {
  computeGovernanceReview,
  type AdvisoryResult,
  type AgentContribution,
  type AdvisoryDirection,
} from "@workspace/domain/agent-system";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) console.log(`  PASS  ${name}`);
  else { console.error(`  FAIL  ${name}${detail ? " — " + detail : ""}`); failures++; }
}

console.log("Agent traffic enforcement test");

function contrib(over: Partial<AgentContribution> = {}): AgentContribution {
  return {
    agentKey: "STRUCT", name: "Market Structure AI", department: "MARKET_STRUCTURE",
    stance: "SUPPORT", delta: 2, trustScore: 85, authorityWeight: 0.2,
    effectiveInfluence: 0.2, reason: "trusted_agent_supports", ...over,
  };
}

function advisory(over: Partial<AdvisoryResult> = {}): AdvisoryResult {
  const contributions = over.contributions ?? [contrib()];
  return {
    baseScore: 60, adjustedScore: 64, netDelta: 4,
    contributions, cautions: [], summary: "ok",
    influencingAgentCount: contributions.filter((c) => Math.abs(c.delta) > 0.5).length,
    hasUntrustedResponsibleAgent: false, ...over,
  };
}

const D: AdvisoryDirection = "BUY";

// A supporter (selected) + a high-authority RISK agent that REJECTS under an
// extreme riskScore context (would veto the setup).
function splitAdvisory(): AdvisoryResult {
  return advisory({
    contributions: [
      contrib({ agentKey: "STRUCT", stance: "SUPPORT", delta: 3, authorityWeight: 0.1, effectiveInfluence: 0.1 }),
      contrib({
        agentKey: "RISK", name: "Risk Governor AI", department: "RISK",
        stance: "CHALLENGE", delta: -8, trustScore: 90, authorityWeight: 0.9,
        effectiveInfluence: 0.9, reason: "risk_rejects_setup",
      }),
    ],
  });
}

// Extreme riskScore makes the RISK agent take a rejection position (a real veto).
const VETO_CTX = { riskScore: 90 } as const;

// 1. WITHOUT an allow-list (fail-open): the RISK agent votes → its rejection lands.
let baselineRejected = false;
{
  const r = computeGovernanceReview({
    surface: "SCANNER", direction: D, importance: "MEDIUM",
    advisory: splitAdvisory(), context: VETO_CTX,
  });
  baselineRejected = r.outcome === "rejected";
  check("fail-open: no allow-list lets RISK vote (rejection lands)", baselineRejected, `outcome=${r.outcome}`);
  check("fail-open: RISK raises a challenge", r.challenges.some((c) => c.byAgentKey === "RISK"));
  check("fail-open: both agents participate", r.participatingAgentCount === 2, `count=${r.participatingAgentCount}`);
}

// 2. WITH an allow-list that EXCLUDES RISK: it steps back — no vote, no challenge,
//    and the rejection no longer lands. This is the functional enforcement.
{
  const r = computeGovernanceReview({
    surface: "SCANNER", direction: D, importance: "MEDIUM",
    advisory: splitAdvisory(), context: VETO_CTX,
    allowedAgentKeys: ["STRUCT"],
  });
  const riskPos = r.positions.find((p) => p.agentKey === "RISK");
  check("enforced: excluded RISK is recorded (still considered)", !!riskPos);
  check("enforced: excluded RISK abstains", riskPos?.position === "abstain");
  check("enforced: excluded RISK has zero weight", riskPos?.weight === 0);
  check(
    "enforced: excluded RISK marked stepped-back by traffic controller",
    riskPos?.reason === "stepped_back_not_selected_by_traffic_controller",
  );
  check("enforced: excluded RISK raises no challenge", !r.challenges.some((c) => c.byAgentKey === "RISK"));
  check("enforced: only the selected agent participates", r.participatingAgentCount === 1, `count=${r.participatingAgentCount}`);
  check("enforced: rejection no longer lands once RISK steps back", r.outcome !== "rejected", `outcome=${r.outcome}`);
  // Enforcement changed the outcome vs the fail-open baseline — proof it is FUNCTIONAL.
  check("enforcement actually changes the decision vs fail-open", baselineRejected && r.outcome !== "rejected");
}

// 3. Selected agent still works end-to-end (governance applied, score protective).
{
  const r = computeGovernanceReview({
    surface: "SCANNER", direction: D, importance: "MEDIUM",
    advisory: splitAdvisory(), context: VETO_CTX,
    allowedAgentKeys: ["STRUCT"],
  });
  check("selected agent still governs (applied)", r.governanceApplied === true);
  check("governed score stays protective (<= advisory)", r.governanceScore <= r.advisoryScore);
}

// 4. Empty allow-list is treated as fail-open (no enforcement) — never silently
//    mutes the whole team into a no-op review.
{
  const r = computeGovernanceReview({
    surface: "SCANNER", direction: D, importance: "MEDIUM",
    advisory: splitAdvisory(), context: VETO_CTX,
    allowedAgentKeys: [],
  });
  check("empty allow-list is fail-open (RISK still votes)", r.outcome === "rejected", `outcome=${r.outcome}`);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll traffic enforcement checks passed.");

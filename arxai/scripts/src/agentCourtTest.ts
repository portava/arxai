// Agent Ecosystem — Layer 3 Governance Court unit tests (PURE, no DB).
// Verifies the inviolable governance invariants: shadow/muted agents (effective
// influence 0) take no position and raise no challenge; the Court resolves by
// AUTHORITY-WEIGHTING (one trusted high-authority objection beats many weak
// supporters); governance can only LOWER the score vs advisory, never inflate;
// concrete department×context challenges drive the right outcome; and the engine
// is deterministic and never an execution gate.
//
// Run: pnpm --filter @workspace/scripts run test:agent-court

import {
  computeGovernanceReview,
  type AdvisoryResult,
  type AgentContribution,
  type AdvisoryDirection,
  type GovernanceContext,
} from "@workspace/domain/agent-system";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) { console.log(`  PASS  ${name}`); }
  else { console.error(`  FAIL  ${name}`); failures++; }
}

console.log("Agent governance court test");

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

// 1. Shadow / muted agent (effectiveInfluence 0) abstains and raises no challenge.
{
  const r = computeGovernanceReview({
    surface: "SCANNER", direction: D, importance: "HIGH",
    advisory: advisory({
      contributions: [contrib({ authorityWeight: 0, effectiveInfluence: 0, stance: "CHALLENGE" })],
    }),
  });
  check("shadow agent abstains", r.positions[0].position === "abstain");
  check("shadow agent raises no challenge", r.challenges.length === 0);
  check("no influencers => governance not applied", r.governanceApplied === false);
  check("no influencers => score unchanged from advisory", r.governanceScore === r.advisoryScore);
}

// 2. Trusted RISK agent + extreme riskScore => rejection => outcome rejected.
{
  const ctx: GovernanceContext = { riskScore: 90 };
  const r = computeGovernanceReview({
    surface: "SCANNER", direction: D, importance: "HIGH",
    advisory: advisory({
      adjustedScore: 70,
      contributions: [contrib({ agentKey: "RISK", name: "Risk AI", department: "RISK", stance: "CHALLENGE", effectiveInfluence: 0.2 })],
    }),
    context: ctx,
  });
  check("extreme risk => RISK takes rejection position", r.positions[0].position === "rejection");
  check("extreme risk => outcome rejected", r.outcome === "rejected");
  check("rejected lowers score below advisory", r.governanceScore < r.advisoryScore);
  check("rejected emits a challenge", r.challenges.some((c) => c.challengeType === "rejection"));
}

// 3. Trusted RISK agent + high (not extreme) risk => downgrade outcome.
{
  const r = computeGovernanceReview({
    surface: "SCANNER", direction: D, importance: "HIGH",
    advisory: advisory({
      contributions: [contrib({ agentKey: "RISK", name: "Risk AI", department: "RISK", stance: "CAUTION", effectiveInfluence: 0.2 })],
    }),
    context: { riskScore: 75 },
  });
  check("high risk => downgrade position", r.positions[0].position === "downgrade");
  check("high risk => outcome downgraded", r.outcome === "downgraded");
}

// 4. Governance NEVER inflates: with strong supporters, score stays <= advisory.
{
  const r = computeGovernanceReview({
    surface: "SCANNER", direction: D, importance: "HIGH",
    advisory: advisory({
      adjustedScore: 80,
      contributions: [
        contrib({ effectiveInfluence: 0.2, stance: "SUPPORT" }),
        contrib({ agentKey: "PRECISION", department: "ENTRY", effectiveInfluence: 0.12, stance: "SUPPORT" }),
      ],
    }),
  });
  check("approved with all support", r.outcome === "approved");
  check("governance score never exceeds advisory", r.governanceScore <= r.advisoryScore);
  check("approved applies no haircut", r.governanceScore === r.advisoryScore);
}

// 5. Authority-weighting (NOT averaging): one trusted high-authority rejection
//    beats several weak supporters.
{
  const weakSupporters = Array.from({ length: 5 }, (_, i) =>
    contrib({ agentKey: `W${i}`, name: `Weak ${i}`, department: "ENTRY", stance: "SUPPORT", effectiveInfluence: 0.05 }));
  const r = computeGovernanceReview({
    surface: "SCANNER", direction: D, importance: "HIGH",
    advisory: advisory({
      adjustedScore: 70,
      contributions: [
        ...weakSupporters,
        contrib({ agentKey: "RISK", name: "Risk AI", department: "RISK", stance: "CHALLENGE", effectiveInfluence: 0.2 }),
      ],
    }),
    context: { riskScore: 90 },
  });
  check("authority beats a crowd of weak supporters", r.outcome === "rejected");
}

// 6. Strong support AND strong rejection both present => escalated.
{
  const r = computeGovernanceReview({
    surface: "SCANNER", direction: D, importance: "HIGH",
    advisory: advisory({
      adjustedScore: 70,
      contributions: [
        contrib({ agentKey: "STRUCT", department: "MARKET_STRUCTURE", stance: "SUPPORT", effectiveInfluence: 0.3 }),
        contrib({ agentKey: "RISK", name: "Risk AI", department: "RISK", stance: "CHALLENGE", effectiveInfluence: 0.3 }),
      ],
    }),
    context: { riskScore: 90 },
  });
  check("conflicting strong camps => escalated", r.outcome === "escalated");
}

// 7. insufficientData => needs_more_data.
{
  const r = computeGovernanceReview({
    surface: "SCANNER", direction: D, importance: "HIGH",
    advisory: advisory({
      contributions: [contrib({ department: "SCANNER", agentKey: "SCANNER_AI", effectiveInfluence: 0.2, stance: "SUPPORT" })],
    }),
    context: { insufficientData: true },
  });
  check("insufficient data => needs_more_data position", r.positions[0].position === "needs_more_data");
  check("insufficient data => needs_more_data outcome", r.outcome === "needs_more_data");
}

// 8. SCALP weak flame => challenge.
{
  const r = computeGovernanceReview({
    surface: "SCALP", direction: D, importance: "MEDIUM",
    advisory: advisory({
      contributions: [contrib({ agentKey: "SCALP_AI", name: "Scalp AI", department: "SCALP", stance: "SUPPORT", effectiveInfluence: 0.2 })],
    }),
    context: { weakFlame: true },
  });
  check("weak flame => scalp challenge", r.challenges.some((c) => c.byDepartment === "SCALP" && c.challengeType === "challenge"));
  check("weak flame => downgraded", r.outcome === "downgraded");
}

// 9. No participants at all => approved (no untrusted) / needs_more_data (untrusted).
{
  const clean = computeGovernanceReview({
    surface: "SCANNER", direction: D, importance: "LOW",
    advisory: advisory({ contributions: [contrib({ authorityWeight: 0, effectiveInfluence: 0 })] }),
  });
  check("no influence, no untrusted => approved", clean.outcome === "approved");
  const untrusted = computeGovernanceReview({
    surface: "SCANNER", direction: D, importance: "LOW",
    advisory: advisory({ contributions: [contrib({ authorityWeight: 0, effectiveInfluence: 0 })], hasUntrustedResponsibleAgent: true }),
  });
  check("no influence, untrusted responsible => needs_more_data", untrusted.outcome === "needs_more_data");
}

// 10. Lifecycle recommendation from poor recent performance.
{
  const r = computeGovernanceReview({
    surface: "SCANNER", direction: D, importance: "HIGH",
    advisory: advisory({
      contributions: [contrib({ agentKey: "PRECISION", name: "Entry Timing AI", department: "ENTRY", stance: "SUPPORT", effectiveInfluence: 0.12 })],
    }),
    context: { poorRecentAgentKeys: ["PRECISION"] },
  });
  check("poor-recent agent => learning-camp recommendation", r.lifecycleRecommendations.some((x) => x.agentKey === "PRECISION" && x.action === "LEARNING_CAMP"));
  check("benign outcome flips to learning_camp_review", r.outcome === "learning_camp_review");
}

// 11. Determinism: same input twice => identical output.
{
  const input = {
    surface: "SCANNER", direction: D, importance: "HIGH" as const,
    advisory: advisory({ contributions: [contrib({ agentKey: "RISK", department: "RISK", stance: "CHALLENGE", effectiveInfluence: 0.2 })] }),
    context: { riskScore: 75 },
  };
  const a = computeGovernanceReview(input);
  const b = computeGovernanceReview(input);
  check("court is deterministic", JSON.stringify(a) === JSON.stringify(b));
}

// 12. Score impact is always relative to base and bounded; confidence within 0-100.
{
  const r = computeGovernanceReview({
    surface: "SCANNER", direction: D, importance: "HIGH",
    advisory: advisory({ baseScore: 60, adjustedScore: 70, contributions: [contrib({ agentKey: "RISK", department: "RISK", stance: "CHALLENGE", effectiveInfluence: 0.2 })] }),
    context: { riskScore: 90 },
  });
  check("scoreImpact = governanceScore - baseScore", Math.abs(r.scoreImpact - (r.governanceScore - r.baseScore)) < 0.011);
  check("confidence within 0-100", r.confidenceScore >= 0 && r.confidenceScore <= 100);
}

if (failures > 0) {
  console.error(`\nAgent governance court test: ${failures} FAILED`);
  process.exit(1);
}
console.log("\nAgent governance court test: ALL PASS");
export {};

// Agent advisory influence engine unit tests (PURE, no DB). Verifies the
// inviolable advisory invariants: shadow agents (authority 0) contribute zero;
// influence is bounded; trusted agents add weight; weak / muted / opposing
// agents pull weight down; the score never escapes 0-100; and the engine never
// becomes an execution gate (it only returns numbers + plain-English copy).
//
// Run: pnpm --filter @workspace/scripts run test:agent-advisory

import {
  computeAgentAdvisory,
  statusInfluenceMultiplier,
  type AdvisoryAgentSnapshot,
} from "@workspace/domain/agent-system";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) { console.log(`  PASS  ${name}`); }
  else { console.error(`  FAIL  ${name}`); failures++; }
}

console.log("Agent advisory engine test");

const trustedActive = (over: Partial<AdvisoryAgentSnapshot> = {}): AdvisoryAgentSnapshot => ({
  agentKey: "TREND", name: "Trend Analyst", department: "TREND",
  trustScore: 90, authorityWeight: 1, currentStatus: "ACTIVE", ...over,
});

// 1. Shadow agent (authority 0) contributes EXACTLY zero — new agents can't move ranking.
{
  const r = computeAgentAdvisory({
    baseScore: 60, direction: "BUY",
    agents: [trustedActive({ authorityWeight: 0, currentStatus: "SHADOW" })],
  });
  check("shadow agent (authority 0) yields zero net delta", r.netDelta === 0);
  check("shadow agent leaves base score unchanged", r.adjustedScore === 60);
  check("shadow agent counts as zero influencers", r.influencingAgentCount === 0);
}

// 2. A trusted, fully-authorized, supporting agent ADDS bounded weight.
{
  const r = computeAgentAdvisory({
    baseScore: 60, direction: "BUY",
    agents: [trustedActive({ alignment: "SUPPORT" })],
  });
  check("trusted supporter raises score", r.adjustedScore > 60);
  check("trusted supporter is a SUPPORT stance", r.contributions[0].stance === "SUPPORT");
  check("single-agent delta is bounded to per-agent cap (<=8)", Math.abs(r.contributions[0].delta) <= 8);
}

// 3. A trusted agent that OPPOSES the direction pulls the score down (CHALLENGE).
{
  const r = computeAgentAdvisory({
    baseScore: 60, direction: "BUY",
    agents: [trustedActive({ agentKey: "RISK", name: "Risk Governor", department: "RISK", alignment: "OPPOSE" })],
  });
  check("trusted opposer lowers score", r.adjustedScore < 60);
  check("trusted opposer is a CHALLENGE stance", r.contributions[0].stance === "CHALLENGE");
  check("trusted opposer adds a caution", r.cautions.length > 0);
}

// 4. A LOW-trust agent cannot strongly boost — its supportive push is small.
{
  const weak = computeAgentAdvisory({
    baseScore: 60, direction: "BUY",
    agents: [trustedActive({ trustScore: 10, alignment: "SUPPORT" })],
  });
  const strong = computeAgentAdvisory({
    baseScore: 60, direction: "BUY",
    agents: [trustedActive({ trustScore: 95, alignment: "SUPPORT" })],
  });
  check("low-trust supporter adds little or nothing", weak.netDelta <= 1);
  check("high-trust supporter clearly out-influences low-trust", strong.netDelta > weak.netDelta);
}

// 5. A muted / learning-camp agent (status mult 0) contributes zero and, if
//    distressed, surfaces an honest 'under review' caution.
{
  const r = computeAgentAdvisory({
    baseScore: 70, direction: "SELL",
    agents: [trustedActive({ currentStatus: "LEARNING_CAMP", alignment: "SUPPORT" })],
  });
  check("learning-camp agent has zero effective influence", r.contributions[0].effectiveInfluence === 0);
  check("learning-camp agent does not change the score", r.adjustedScore === 70);
  check("learning-camp agent surfaces an under-review caution", r.cautions.some((c) => /under review/i.test(c)));
  check("learning-camp flips the untrusted-responsible flag", r.hasUntrustedResponsibleAgent === true);
}

// 6. Total influence is bounded even with many strong supporters.
{
  const many = Array.from({ length: 20 }, (_, i) =>
    trustedActive({ agentKey: `A${i}`, name: `Agent ${i}`, alignment: "SUPPORT" }));
  const r = computeAgentAdvisory({ baseScore: 50, direction: "BUY", agents: many, maxTotalAdjustment: 15 });
  check("net delta clamped to max total (<=15)", r.netDelta <= 15);
  check("adjusted score never exceeds 100", r.adjustedScore <= 100);
}

// 7. Score never escapes 0-100 even with extreme base + opposition.
{
  const lo = computeAgentAdvisory({
    baseScore: 3, direction: "BUY",
    agents: [trustedActive({ department: "RISK", alignment: "OPPOSE" }), trustedActive({ agentKey: "VOL", alignment: "OPPOSE" })],
  });
  check("adjusted score floored at 0", lo.adjustedScore >= 0);
  const hi = computeAgentAdvisory({
    baseScore: 99, direction: "BUY",
    agents: [trustedActive({ alignment: "SUPPORT" }), trustedActive({ agentKey: "STRUCT", alignment: "SUPPORT" })],
  });
  check("adjusted score capped at 100", hi.adjustedScore <= 100);
}

// 8. WARNING / PROBATION / RESTRICTED damp (not zero, not full) — monotone.
{
  check("ACTIVE multiplier is full", statusInfluenceMultiplier("ACTIVE") === 1);
  check("WARNING damps below ACTIVE", statusInfluenceMultiplier("WARNING") < 1);
  check("PROBATION damps below WARNING", statusInfluenceMultiplier("PROBATION") < statusInfluenceMultiplier("WARNING"));
  check("RESTRICTED damps below PROBATION", statusInfluenceMultiplier("RESTRICTED") < statusInfluenceMultiplier("PROBATION"));
  check("ARCHIVED is fully muted", statusInfluenceMultiplier("ARCHIVED") === 0);
  check("unknown status is fully muted (fail-closed)", statusInfluenceMultiplier("???") === 0);
}

// 9. No agents at all => unchanged score + honest 'no agent earned standing' summary.
{
  const r = computeAgentAdvisory({ baseScore: 55, direction: "NEUTRAL", agents: [] });
  check("empty registry leaves score unchanged", r.adjustedScore === 55);
  check("empty registry summary is honest", /no experienced agent/i.test(r.summary));
}

// 10. Determinism: same input twice => identical output.
{
  const input = { baseScore: 64, direction: "BUY" as const, agents: [trustedActive({ alignment: "SUPPORT" })] };
  const a = computeAgentAdvisory(input);
  const b = computeAgentAdvisory(input);
  check("engine is deterministic", JSON.stringify(a) === JSON.stringify(b));
}

if (failures > 0) {
  console.error(`\nAgent advisory test: ${failures} FAILED`);
  process.exit(1);
}
console.log("\nAgent advisory test: ALL PASS");
export {};

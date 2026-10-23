// Agent Ecosystem — Layer 3 speed + step-back unit tests (PURE, no DB).
// Covers spec test cases 20-21:
//   20. A slow / redundant / off-specialty agent steps back.
//   21. A correct step-back earns a small speed + usefulness reward (feeds
//       Layer 2 scoring); a step-back that dropped a decisive unique
//       contribution is penalized instead.
// Plus the inviolable guard: protective (Risk) and uniquely-decisive agents
// NEVER step back. None of this gates or slows execution — it only re-routes
// nonessential agents off the hot path.
//
// Run: pnpm --filter @workspace/scripts run test:agent-speed

import {
  evaluateStepBack,
  rewardStepBack,
  computeSpeedCostScore,
  initSpeedMetrics,
  type AgentSpeedMetrics,
  type StepBackEvaluationInput,
} from "@workspace/domain/agent-system";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) { console.log(`  PASS  ${name}`); }
  else { console.error(`  FAIL  ${name}`); failures++; }
}

console.log("Agent speed + step-back test");

function metrics(over: Partial<AgentSpeedMetrics> = {}): AgentSpeedMetrics {
  return { ...initSpeedMetrics("X"), ...over };
}

function input(over: Partial<StepBackEvaluationInput> = {}): StepBackEvaluationInput {
  return {
    agentKey: "STRUCT", department: "MARKET_STRUCTURE",
    relevantDepartments: ["MARKET_STRUCTURE"],
    metrics: metrics(),
    isDuplicate: false,
    mode: "SCANNER",
    ...over,
  };
}

// speedCostScore: a slow, low-value, duplicative agent scores high (expensive).
{
  const cheap = computeSpeedCostScore({ avgRuntimeMs: 20, usefulnessPerMs: 0.003, duplicateAnalysisRate: 0 });
  const dear = computeSpeedCostScore({ avgRuntimeMs: 800, usefulnessPerMs: 0, duplicateAnalysisRate: 0.9 });
  check("fast useful agent is cheap", cheap < 20);
  check("slow useless duplicative agent is expensive", dear > 70);
}

// 20a. Redundant duplicate analysis => step back to silent support.
{
  const r = evaluateStepBack(input({ isDuplicate: true }));
  check("20: duplicate agent steps back", r.shouldStepBack === true);
  check("20: duplicate reason is redundant", r.triggers.includes("redundant_duplicate_analysis"));
  check("20: duplicate recommended SILENT_SUPPORT", r.recommendedMode === "SILENT_SUPPORT");
}

// 20b. Slow agent in a speed-critical (SCALP) mode steps back.
{
  const r = evaluateStepBack(input({
    mode: "SCALP",
    relevantDepartments: ["SCALP", "RISK"],
    department: "SCALP",
    metrics: metrics({ speedCostScore: 70 }),
  }));
  check("20: slow agent in scalp mode steps back", r.shouldStepBack === true);
  check("20: slow trigger fired", r.triggers.includes("slowing_live_execution"));
}

// 20c. Off-specialty agent steps back.
{
  const r = evaluateStepBack(input({ department: "REVIEW", relevantDepartments: ["SCALP", "RISK"] }));
  check("20: off-specialty agent steps back", r.shouldStepBack === true);
  check("20: off-specialty trigger fired", r.triggers.includes("outside_specialty"));
}

// Protective Risk agent NEVER steps back even when slow/duplicate.
{
  const r = evaluateStepBack(input({
    department: "RISK", isProtective: true, isDuplicate: true,
    metrics: metrics({ speedCostScore: 99 }), mode: "SCALP",
  }));
  check("protective Risk agent never steps back", r.shouldStepBack === false);
  check("protective Risk agent has no triggers", r.triggers.length === 0);
}

// Uniquely-decisive agent never steps back.
{
  const r = evaluateStepBack(input({ isDecisiveUnique: true, isDuplicate: true }));
  check("uniquely decisive agent never steps back", r.shouldStepBack === false);
}

// A relevant, fast, on-specialty agent does NOT step back.
{
  const r = evaluateStepBack(input({ metrics: metrics({ changedDecisionRate: 0.6, usefulnessPerMs: 0.003 }) }));
  check("useful on-specialty agent stays", r.shouldStepBack === false);
}

// 21. Correct step-back earns a reward; a wrong one is penalized.
{
  const good = rewardStepBack({ steppedBack: true, wouldHaveChangedDecision: false, wasUniqueContribution: false });
  check("21: correct step-back is correct", good.correct === true);
  check("21: correct step-back rewards speed", good.speedScoreDelta > 0);
  check("21: correct step-back rewards usefulness", good.usefulnessScoreDelta > 0);

  const bad = rewardStepBack({ steppedBack: true, wouldHaveChangedDecision: true, wasUniqueContribution: true });
  check("21: dropping a decisive unique contribution is incorrect", bad.correct === false);
  check("21: bad step-back penalizes speed", bad.speedScoreDelta < 0);
  check("21: bad step-back penalizes usefulness", bad.usefulnessScoreDelta < 0);

  const none = rewardStepBack({ steppedBack: false, wouldHaveChangedDecision: false, wasUniqueContribution: false });
  check("21: no step-back => no reward/penalty", none.speedScoreDelta === 0 && none.usefulnessScoreDelta === 0);
}

if (failures > 0) {
  console.error(`\nAgent speed + step-back test: ${failures} FAILED`);
  process.exit(1);
}
console.log("\nAgent speed + step-back test: ALL PASS");
export {};

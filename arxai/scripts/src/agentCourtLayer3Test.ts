// Agent Ecosystem — Layer 3 Agent Court unit tests (PURE, no DB).
// Covers spec test case 23: the Court resolves a disagreement by WEIGHTED
// SPECIALTY AUTHORITY (never by averaging), applies the Risk protective veto,
// and emits a persistable disagreement record for later who-was-right scoring.
// This is learning evidence only — it is never an execution gate.
//
// Run: pnpm --filter @workspace/scripts run test:agent-court-layer3

import {
  resolveDisagreement,
  type CourtPosition,
  type CourtContext,
} from "@workspace/domain/agent-system";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) { console.log(`  PASS  ${name}`); }
  else { console.error(`  FAIL  ${name}`); failures++; }
}

console.log("Agent court (Layer 3) test");

const ctx: CourtContext = { symbol: "V75", timeframe: "M5", tradeType: "scalp", condition: "high_vol" };

function pos(over: Partial<CourtPosition> = {}): CourtPosition {
  return {
    agentKey: "X", agentName: "Agent X", department: "ENTRY",
    decision: "approve", confidence: 70, hasSpecialtyAuthority: false,
    authorityWeight: 0.3, ...over,
  };
}

// 23a. Authority-weighting, NOT averaging: one high-authority specialty reject
//      beats a crowd of weak approvers.
{
  const weakApprovers: CourtPosition[] = Array.from({ length: 5 }, (_, i) =>
    pos({ agentKey: `W${i}`, agentName: `Weak ${i}`, decision: "approve", confidence: 60, authorityWeight: 0.1 }));
  const strongReject = pos({
    agentKey: "SCALP", agentName: "Scalp AI", department: "SCALP", decision: "reject",
    confidence: 90, hasSpecialtyAuthority: true, authorityWeight: 0.9, conditionPerformance: 85,
  });
  const r = resolveDisagreement([...weakApprovers, strongReject], ctx);
  check("23: authority beats a crowd of weak approvers", r.winningDecision === "reject");
  check("23: resolved by authority not average", r.resolvedByAuthorityNotAverage === true);
  check("23: a simple majority (5 approve vs 1 reject) did NOT win", r.outcome !== "APPROVE");
}

// 23b. Risk protective veto caps the outcome even against a louder bullish camp.
{
  const bulls: CourtPosition[] = [
    pos({ agentKey: "S1", department: "SCANNER", decision: "approve", direction: "BUY", confidence: 85, authorityWeight: 0.6 }),
    pos({ agentKey: "S2", department: "ENTRY", decision: "approve", direction: "BUY", confidence: 80, authorityWeight: 0.5 }),
  ];
  const risk = pos({
    agentKey: "RISK", agentName: "Risk AI", department: "RISK", decision: "reject",
    isRiskAgent: true, confidence: 75, hasSpecialtyAuthority: true, authorityWeight: 0.5,
  });
  const r = resolveDisagreement([...bulls, risk], ctx);
  check("23: risk veto applied", r.riskVetoApplied === true);
  check("23: veto caps outcome away from APPROVE", r.outcome !== "APPROVE");
}

// 23c. The resolution emits a persistable disagreement record.
{
  const r = resolveDisagreement(
    [pos({ agentKey: "A", decision: "approve" }), pos({ agentKey: "B", decision: "caution" })],
    ctx,
  );
  const rec = r.disagreementRecord;
  check("23: record carries the context symbol", rec.symbol === "V75");
  check("23: record carries the resolved outcome", rec.resolvedOutcome === r.outcome);
  check("23: record carries the winning decision", rec.winningDecision === r.winningDecision);
  check("23: record has one entry per position", rec.positions.length === 2);
  check("23: record positions carry computed weights", rec.positions.every((p) => typeof p.weight === "number"));
}

// Determinism + empty guard.
{
  const args: [CourtPosition[], CourtContext] = [
    [pos({ agentKey: "A", decision: "approve" }), pos({ agentKey: "RISK", isRiskAgent: true, decision: "reject" })],
    ctx,
  ];
  const a = resolveDisagreement(...args);
  const b = resolveDisagreement(...args);
  check("court is deterministic", JSON.stringify(a) === JSON.stringify(b));

  let threw = false;
  try { resolveDisagreement([], ctx); } catch { threw = true; }
  check("empty positions throws (no silent default)", threw === true);
}

if (failures > 0) {
  console.error(`\nAgent court (Layer 3) test: ${failures} FAILED`);
  process.exit(1);
}
console.log("\nAgent court (Layer 3) test: ALL PASS");
export {};

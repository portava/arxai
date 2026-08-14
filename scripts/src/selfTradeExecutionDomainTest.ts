// Unit tests for the Self-Trade AI autonomous-execution PURE domain modules
// (Task #213): executionPermission, riskAwareLotSizer, quotaPressure,
// positionManagement. No IO; deterministic. Run: pnpm --filter @workspace/scripts
// run test:self-trade-execution-domain

import {
  evaluateExecutionPermission,
  computeRiskAwareLot,
  evaluateQuotaPressure,
  evaluateManagementAction,
  type ExecutionPermissionInput,
  type QuotaContext,
  type GovernorContext,
  type HandshakeReadinessContext,
  type TradeThesis,
} from "@workspace/domain/self-trade";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const NOW = Date.parse("2026-06-06T12:00:00Z");

function okQuota(): QuotaContext {
  return {
    dailyMinTrades: 3,
    effectiveMaxTrades: 5,
    tradesTakenToday: 1,
    remainingToMax: 4,
    belowDailyMinimum: true,
    baseReached: false,
    hardCapReached: false,
  };
}
function okGovernor(): GovernorContext {
  return { status: "PAPER_ALLOWED", hardBlocks: [] };
}
function okHandshake(): HandshakeReadinessContext {
  return { ready: true, degraded: [], blocked: [] };
}
function okThesis(): TradeThesis {
  return {
    symbol: "EURUSD",
    side: "BUY",
    setup: "TREND_CONTINUATION" as TradeThesis["setup"],
    whyNow: ["trend"],
    entryZone: { from: 1.1, to: 1.1005 },
    stopLoss: 1.095,
    invalidation: 1.094,
    takeProfits: [{ from: 1.105, to: 1.105 }, { from: 1.11, to: 1.11 }],
    edge: 70,
    confidence: 72,
    newsRisk: "low",
  };
}
function basePermInput(over: Partial<ExecutionPermissionInput> = {}): ExecutionPermissionInput {
  return {
    agentStatus: "ACTIVE",
    agentMode: "LIVE",
    autonomyLevel: 2,
    outcome: "APPROVED",
    thesis: okThesis(),
    setupExpiresAt: null,
    funded: true,
    quota: okQuota(),
    governor: okGovernor(),
    handshake: okHandshake(),
    killEngaged: false,
    openPositionsCount: 0,
    maxConcurrentPositions: 1,
    executingUserId: 4,
    hasMasterLiveAccess: true,
    now: NOW,
    ...over,
  };
}

// ── executionPermission ──────────────────────────────────────────────────────
console.log("executionPermission");
{
  const v = evaluateExecutionPermission(basePermInput());
  check("APPROVED + L2 + access ⇒ EXECUTE", v.action === "EXECUTE" && v.permitted, v.action);

  const kill = evaluateExecutionPermission(basePermInput({ killEngaged: true }));
  check("kill switch ⇒ BLOCK", kill.action === "BLOCK" && kill.blockCode === "KILL_SWITCH_ENGAGED", kill.blockCode ?? "");

  const inactive = evaluateExecutionPermission(basePermInput({ agentStatus: "PAUSED" }));
  check("not ACTIVE ⇒ BLOCK", inactive.blockCode === "AGENT_NOT_ACTIVE");

  const unfunded = evaluateExecutionPermission(basePermInput({ funded: false }));
  check("unfunded ⇒ BLOCK", unfunded.blockCode === "AGENT_UNFUNDED");

  const denied = evaluateExecutionPermission(basePermInput({ outcome: "DENIED" }));
  check("non-approved outcome ⇒ BLOCK", denied.blockCode === "OUTCOME_NOT_APPROVED");

  const locked = evaluateExecutionPermission(basePermInput({ governor: { status: "LOCKED", hardBlocks: [] } }));
  check("governor LOCKED ⇒ BLOCK", locked.blockCode === "GOVERNOR_LOCKED");

  const hsBlocked = evaluateExecutionPermission(basePermInput({ handshake: { ready: false, degraded: [], blocked: ["DATA"] } }));
  check("handshake blocked ⇒ BLOCK", hsBlocked.blockCode === "HANDSHAKE_BLOCKED");

  const expired = evaluateExecutionPermission(basePermInput({ setupExpiresAt: "2026-06-06T11:00:00Z" }));
  check("expired setup ⇒ BLOCK", expired.blockCode === "SETUP_EXPIRED");

  const cap = evaluateExecutionPermission(basePermInput({ quota: { ...okQuota(), hardCapReached: true } }));
  check("hard cap ⇒ BLOCK", cap.blockCode === "QUOTA_HARD_CAP");

  const conc = evaluateExecutionPermission(basePermInput({ openPositionsCount: 1, maxConcurrentPositions: 1 }));
  check("max concurrent ⇒ BLOCK", conc.blockCode === "MAX_CONCURRENT_POSITIONS");

  const noThesis = evaluateExecutionPermission(basePermInput({ thesis: null }));
  check("no thesis ⇒ BLOCK", noThesis.blockCode === "NO_THESIS");

  const shadow = evaluateExecutionPermission(basePermInput({ agentMode: "SHADOW" }));
  check("SHADOW ⇒ LOG_ONLY (not permitted)", shadow.action === "LOG_ONLY" && !shadow.permitted);

  const l0 = evaluateExecutionPermission(basePermInput({ autonomyLevel: 0 }));
  check("L0 ⇒ LOG_ONLY", l0.action === "LOG_ONLY" && !l0.permitted);

  const l1 = evaluateExecutionPermission(basePermInput({ autonomyLevel: 1 }));
  check("L1 ⇒ PREPARE_ONLY (permitted)", l1.action === "PREPARE_ONLY" && l1.permitted);

  const prep = evaluateExecutionPermission(basePermInput({ outcome: "PREPARE_ONLY" }));
  check("PREPARE_ONLY outcome ⇒ PREPARE_ONLY", prep.action === "PREPARE_ONLY" && prep.permitted);

  const noUser = evaluateExecutionPermission(basePermInput({ executingUserId: null }));
  check("no executing user ⇒ BLOCK", noUser.blockCode === "NO_EXECUTING_USER");

  const noAccess = evaluateExecutionPermission(basePermInput({ hasMasterLiveAccess: false }));
  check("no master-live access ⇒ BLOCK", noAccess.blockCode === "NO_MASTER_LIVE_ACCESS");

  // Priority: kill switch beats every other failure.
  const both = evaluateExecutionPermission(basePermInput({ killEngaged: true, funded: false, agentStatus: "PAUSED" }));
  check("kill switch is the decisive block", both.blockCode === "KILL_SWITCH_ENGAGED");
}

// ── riskAwareLotSizer ────────────────────────────────────────────────────────
console.log("riskAwareLotSizer");
{
  // $100 risk, 50-pip stop (0.0050), $10/pip-per-lot ⇒ value/unit/lot=100000.
  // riskPerLot = 0.0050 * 100000 = 500 ⇒ rawLot = 100/500 = 0.20.
  const r = computeRiskAwareLot({
    side: "BUY", entryPrice: 1.1, stopLossPrice: 1.095,
    riskBudgetUsd: 100, valuePerUnitPerLot: 100000,
    minLot: 0.01, maxLot: 100, lotStep: 0.01, agentMaxLot: 100, sizeMultiplier: 1,
  });
  check("sizes 0.20 lot", !r.cannotSize && Math.abs(r.lot - 0.2) < 1e-6, `lot=${r.lot}`);
  check("actual risk ≈ budget", Math.abs(r.actualRiskUsd - 100) < 1e-6 && r.withinRiskBudget, `risk=${r.actualRiskUsd}`);

  const noSl = computeRiskAwareLot({
    side: "BUY", entryPrice: 1.1, stopLossPrice: null,
    riskBudgetUsd: 100, valuePerUnitPerLot: 100000,
    minLot: 0.01, maxLot: 100, lotStep: 0.01, agentMaxLot: 100, sizeMultiplier: 1,
  });
  check("no SL ⇒ cannotSize", noSl.cannotSize && noSl.reasonCode === "NO_PROTECTIVE_STOP");

  const zeroDist = computeRiskAwareLot({
    side: "BUY", entryPrice: 1.1, stopLossPrice: 1.1,
    riskBudgetUsd: 100, valuePerUnitPerLot: 100000,
    minLot: 0.01, maxLot: 100, lotStep: 0.01, agentMaxLot: 100, sizeMultiplier: 1,
  });
  check("zero stop distance ⇒ cannotSize", zeroDist.cannotSize && zeroDist.reasonCode === "NO_STOP_DISTANCE");

  const agentCap = computeRiskAwareLot({
    side: "BUY", entryPrice: 1.1, stopLossPrice: 1.095,
    riskBudgetUsd: 100, valuePerUnitPerLot: 100000,
    minLot: 0.01, maxLot: 100, lotStep: 0.01, agentMaxLot: 0.05, sizeMultiplier: 1,
  });
  check("agent cap clamps lot", !agentCap.cannotSize && Math.abs(agentCap.lot - 0.05) < 1e-6 && agentCap.clampedBy === "AGENT_CAP", `lot=${agentCap.lot} by=${agentCap.clampedBy}`);

  const minLotOverRisk = computeRiskAwareLot({
    side: "BUY", entryPrice: 1.1, stopLossPrice: 1.0, // huge stop
    riskBudgetUsd: 1, valuePerUnitPerLot: 100000,
    minLot: 0.01, maxLot: 100, lotStep: 0.01, agentMaxLot: 100, sizeMultiplier: 1,
  });
  check("min lot exceeds budget ⇒ withinRiskBudget=false", !minLotOverRisk.cannotSize && minLotOverRisk.lot === 0.01 && !minLotOverRisk.withinRiskBudget, `within=${minLotOverRisk.withinRiskBudget}`);

  const halfMult = computeRiskAwareLot({
    side: "BUY", entryPrice: 1.1, stopLossPrice: 1.095,
    riskBudgetUsd: 100, valuePerUnitPerLot: 100000,
    minLot: 0.01, maxLot: 100, lotStep: 0.01, agentMaxLot: 100, sizeMultiplier: 0.5,
  });
  check("size multiplier halves lot", Math.abs(halfMult.lot - 0.1) < 1e-6, `lot=${halfMult.lot}`);
}

// ── quotaPressure ────────────────────────────────────────────────────────────
console.log("quotaPressure");
{
  const normal = evaluateQuotaPressure({ dailyPnlUsd: 0, maxDailyLossUsd: 100, dailyProfitGoalUsd: 200, quota: okQuota(), baseMinScore: 60 });
  check("flat ⇒ NORMAL", normal.regime === "NORMAL" && normal.sizeMultiplier === 1 && normal.minScoreThreshold === 60);

  const recovery = evaluateQuotaPressure({ dailyPnlUsd: -20, maxDailyLossUsd: 100, dailyProfitGoalUsd: 200, quota: okQuota(), baseMinScore: 60 });
  check("small drawdown ⇒ RECOVERY", recovery.regime === "RECOVERY" && recovery.sizeMultiplier === 0.7 && recovery.requireExtraConfirmation);

  const protectLoss = evaluateQuotaPressure({ dailyPnlUsd: -80, maxDailyLossUsd: 100, dailyProfitGoalUsd: 200, quota: okQuota(), baseMinScore: 60 });
  check("near loss cap ⇒ PROTECT", protectLoss.regime === "PROTECT" && protectLoss.sizeMultiplier === 0.5);

  const protectGoal = evaluateQuotaPressure({ dailyPnlUsd: 250, maxDailyLossUsd: 100, dailyProfitGoalUsd: 200, quota: okQuota(), baseMinScore: 60 });
  check("goal reached ⇒ PROTECT", protectGoal.regime === "PROTECT" && protectGoal.requireExtraConfirmation);

  const clamp = evaluateQuotaPressure({ dailyPnlUsd: -80, maxDailyLossUsd: 100, dailyProfitGoalUsd: 0, quota: okQuota(), baseMinScore: 90 });
  check("threshold clamps ≤ 95", clamp.minScoreThreshold <= 95);
}

// ── positionManagement ───────────────────────────────────────────────────────
console.log("positionManagement");
{
  // BUY entry 1.1000, SL 1.0950 (R=0.0050). TP1 1.1050, TP2 1.1100, inval 1.0940.
  const base = {
    side: "BUY" as const, entryPrice: 1.1, stopLoss: 1.095, currentSl: 1.095,
    takeProfits: [{ from: 1.105, to: 1.105 }, { from: 1.11, to: 1.11 }],
    invalidation: 1.094, beMoved: false, partialsTaken: 0, autonomyLevel: 3,
  };

  const inval = evaluateManagementAction({ ...base, currentPrice: 1.0935 });
  check("invalidation breach ⇒ EXIT", inval.action === "EXIT");

  const finalTp = evaluateManagementAction({ ...base, currentPrice: 1.1105 });
  check("final target ⇒ EXIT", finalTp.action === "EXIT");

  const partial = evaluateManagementAction({ ...base, currentPrice: 1.1052 });
  check("first TP, no partial ⇒ TAKE_PARTIAL", partial.action === "TAKE_PARTIAL" && partial.partialFraction === 0.5);

  const moveBe = evaluateManagementAction({ ...base, currentPrice: 1.1051, partialsTaken: 1 });
  check("≥1R after partial ⇒ MOVE_TO_BE", moveBe.action === "MOVE_TO_BE" && moveBe.newStopLoss === 1.1);

  const tighten = evaluateManagementAction({ ...base, currentPrice: 1.108, partialsTaken: 1, beMoved: true });
  check("≥1.5R + BE moved ⇒ TIGHTEN_SL", tighten.action === "TIGHTEN_SL" && (tighten.newStopLoss ?? 0) > 1.1, `sl=${tighten.newStopLoss}`);

  const hold = evaluateManagementAction({ ...base, currentPrice: 1.1010 });
  check("small move ⇒ HOLD", hold.action === "HOLD");

  // Never relax a stop: TIGHTEN proposal below current SL degrades to HOLD.
  const noRelax = evaluateManagementAction({ ...base, currentPrice: 1.108, partialsTaken: 1, beMoved: true, currentSl: 1.107 });
  check("never relax stop ⇒ HOLD when proposal worse", noRelax.action === "HOLD" || (noRelax.newStopLoss ?? 0) > 1.107);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

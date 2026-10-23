import type { DecisionTruthStorePort }  from "./decisionTruth.store";
import type { OutcomeTruthStorePort }   from "./outcomeTruth.store";
import type { ExecutionTruthStorePort } from "./executionTruth.store";
import type { BehaviorTruthStorePort }  from "./behaviorTruth.store";
import type {
  VaultQuery, AgentId, StrategyId, VersionId,
  DecisionTruthRecord, OutcomeTruthRecord,
} from "./blackBox.types";

// ═══════════════════════════════════════════════════════════════════════════
// Vault Query Engine — high-level analytics over the truth stores. Pure
// orchestrators that take Port impls + a VaultQuery and return structured
// reports with reasons[] / blockers[].
//
// Capabilities:
//   • gradeAgent(agentId)             — agent performance over time
//   • compareShadowVsLive(strategyId) — shadow vs live edge gap
//   • compareVersions(strategyId, vA, vB) — v1 vs v2 comparison
//   • auditReport()                   — coverage + integrity summary
// ═══════════════════════════════════════════════════════════════════════════

export interface VaultQueryPorts {
  decision:  DecisionTruthStorePort;
  outcome:   OutcomeTruthStorePort;
  execution: ExecutionTruthStorePort;
  behavior:  BehaviorTruthStorePort;
}

export interface AgentGrade {
  agentId: AgentId;
  totalVotes: number;
  approvedVotes: number;
  approvedAndWon: number;
  approvedAndLost: number;
  rejectedAndAvoidedLoss: number;       // REJECT followed by losing outcome elsewhere
  rejectedButWouldHaveWon: number;      // REJECT but a parallel APPROVE won
  hitRate01: number;                    // approvedAndWon / approvedVotes
  meanCalibrationErrorAbs: number;      // mean |confidence - actualWin|
  reasons: string[];
  blockers: string[];
}

export async function gradeAgent(
  agentId: AgentId,
  ports: VaultQueryPorts,
  q: VaultQuery = {},
): Promise<AgentGrade> {
  const reasons: string[] = [];
  const blockers: string[] = [];
  // Pull all decisions in window — agent vote scoping is on .votes inside.
  const decisions = await ports.decision.list(stripAgent(q));
  const grade: AgentGrade = {
    agentId,
    totalVotes: 0, approvedVotes: 0,
    approvedAndWon: 0, approvedAndLost: 0,
    rejectedAndAvoidedLoss: 0, rejectedButWouldHaveWon: 0,
    hitRate01: 0, meanCalibrationErrorAbs: 0,
    reasons, blockers,
  };
  let calSum = 0; let calN = 0;

  for (const d of decisions) {
    const myVote = d.votes.find((v) => v.agentId === agentId);
    if (!myVote) continue;
    grade.totalVotes += 1;

    const tradeId = d.candidateTradeId;
    const outcome = tradeId ? await ports.outcome.byTrade(tradeId) : null;

    if (myVote.vote === "APPROVE") {
      grade.approvedVotes += 1;
      if (outcome) {
        if (outcome.pnlR > 0) grade.approvedAndWon  += 1;
        else                  grade.approvedAndLost += 1;
        const actualWin = outcome.pnlR > 0 ? 1 : 0;
        calSum += Math.abs(myVote.confidence01 - actualWin);
        calN   += 1;
      }
    } else if (myVote.vote === "REJECT") {
      // Did the system act on this decision? If verdict was DENIED and we
      // have no outcome that's an AVOIDED loss claim. If verdict was
      // AUTHORIZED (i.e. quorum overrode this rejector) and the outcome
      // shows a win, this rejector was wrong.
      if (d.verdict === "DENIED") grade.rejectedAndAvoidedLoss += 1;
      else if (d.verdict === "AUTHORIZED" && outcome && outcome.pnlR > 0) {
        grade.rejectedButWouldHaveWon += 1;
      }
    }
  }

  grade.hitRate01 = grade.approvedVotes > 0
    ? grade.approvedAndWon / grade.approvedVotes
    : 0;
  grade.meanCalibrationErrorAbs = calN > 0 ? calSum / calN : 0;

  if (grade.totalVotes === 0) {
    blockers.push(`agent ${agentId} has no votes in window — grade is meaningless`);
  } else {
    reasons.push(`graded agent ${agentId} on ${grade.totalVotes} votes, hit-rate ${grade.hitRate01.toFixed(3)}, calibration err ${grade.meanCalibrationErrorAbs.toFixed(3)}`);
  }
  return grade;
}

export interface PerformanceSummary {
  trades: number;
  wins: number;
  losses: number;
  winRate01: number;
  expectancyR: number;
  meanSlippagePips: number;
  meanLatencyMs: number;
}

export interface ShadowVsLiveResult {
  strategyId: StrategyId;
  shadow: PerformanceSummary;
  live: PerformanceSummary;
  edgeGapR: number;                              // live - shadow expectancy R
  reasons: string[];
  blockers: string[];
}

export async function compareShadowVsLive(
  strategyId: StrategyId,
  ports: VaultQueryPorts,
  q: VaultQuery = {},
): Promise<ShadowVsLiveResult> {
  const reasons: string[] = [];
  const blockers: string[] = [];

  const liveQ:   VaultQuery = { ...q, strategyId, shadow: false };
  const shadowQ: VaultQuery = { ...q, strategyId, shadow: true };
  const live   = await summarize(liveQ,   ports);
  const shadow = await summarize(shadowQ, ports);

  if (live.trades === 0)   blockers.push(`no live trades for strategy ${strategyId} in window`);
  if (shadow.trades === 0) blockers.push(`no shadow trades for strategy ${strategyId} in window`);
  reasons.push(`shadow ${shadow.trades} trades expR ${shadow.expectancyR.toFixed(3)}, live ${live.trades} trades expR ${live.expectancyR.toFixed(3)}`);

  return {
    strategyId, shadow, live,
    edgeGapR: live.expectancyR - shadow.expectancyR,
    reasons, blockers,
  };
}

export interface VersionComparisonResult {
  strategyId: StrategyId;
  versionA: VersionId;
  versionB: VersionId;
  a: PerformanceSummary;
  b: PerformanceSummary;
  expectancyDeltaR: number;                      // b - a
  reasons: string[];
  blockers: string[];
}

export async function compareVersions(
  strategyId: StrategyId,
  versionA: VersionId,
  versionB: VersionId,
  ports: VaultQueryPorts,
  q: VaultQuery = {},
): Promise<VersionComparisonResult> {
  const reasons: string[] = [];
  const blockers: string[] = [];
  if (versionA === versionB) {
    blockers.push(`versionA and versionB are identical (${versionA}) — refusing to compare`);
  }
  const a = await summarize({ ...q, strategyId, versionId: versionA }, ports);
  const b = await summarize({ ...q, strategyId, versionId: versionB }, ports);
  if (a.trades === 0) blockers.push(`no trades for ${strategyId} v=${versionA} in window`);
  if (b.trades === 0) blockers.push(`no trades for ${strategyId} v=${versionB} in window`);
  reasons.push(`v${versionA} expR ${a.expectancyR.toFixed(3)} (${a.trades}) vs v${versionB} expR ${b.expectancyR.toFixed(3)} (${b.trades})`);
  return {
    strategyId, versionA, versionB, a, b,
    expectancyDeltaR: b.expectancyR - a.expectancyR,
    reasons, blockers,
  };
}

export interface AuditReport {
  totalDecisions: number;
  totalBlockedSetups: number;
  totalExecutions: number;
  totalOutcomes: number;
  decisionsWithoutOutcome: number;       // candidate trades that have no outcome
  outcomesWithoutDecision: number;       // outcomes whose decisionId is unknown
  overrideEvents: number;
  // Optional integrity-scan rollup — populated when the caller passes
  // pre-built ReplayPackets and an integrity scanner result.
  integrityFlagCount: number;
  integrityCriticalCount: number;
  integrityByCategory: Record<string, number>;
  reasons: string[];
  blockers: string[];
}

export interface AuditExtras {
  // Caller passes pre-scanned integrity flags (e.g. from
  // dataIntegrity.scanManyPackets) so audit rollup includes them.
  integrityFlags?: ReadonlyArray<{ severity: string; category: string }>;
}

export async function auditReport(
  ports: VaultQueryPorts,
  q: VaultQuery = {},
  extras: AuditExtras = {},
): Promise<AuditReport> {
  const reasons: string[] = [];
  const blockers: string[] = [];
  const decisions  = await ports.decision.list(q);
  const executions = await ports.execution.list(q);
  const outcomes   = await ports.outcome.list(q);
  const behaviors  = await ports.behavior.list(q);

  const blockedSetups = decisions.filter((d) => d.verdict === "DENIED").length;
  const tradeIdsWithOutcome = new Set(outcomes.map((o) => o.tradeId));
  const decisionIdSet = new Set(decisions.map((d) => d.decisionId));

  let decisionsWithoutOutcome = 0;
  for (const d of decisions) {
    if (d.verdict === "AUTHORIZED" && d.candidateTradeId && !tradeIdsWithOutcome.has(d.candidateTradeId)) {
      decisionsWithoutOutcome += 1;
    }
  }
  let outcomesWithoutDecision = 0;
  for (const o of outcomes) {
    if (o.decisionId && !decisionIdSet.has(o.decisionId)) outcomesWithoutDecision += 1;
  }

  if (outcomesWithoutDecision > 0) {
    blockers.push(`${outcomesWithoutDecision} outcome(s) reference unknown decisionIds — audit trail broken`);
  }

  const flags = extras.integrityFlags ?? [];
  const integrityByCategory: Record<string, number> = {};
  let integrityCriticalCount = 0;
  for (const f of flags) {
    integrityByCategory[f.category] = (integrityByCategory[f.category] ?? 0) + 1;
    if (f.severity === "CRITICAL") integrityCriticalCount += 1;
  }
  if (integrityCriticalCount > 0) {
    blockers.push(`${integrityCriticalCount} CRITICAL integrity flag(s) in window — bad data must NOT train AI`);
  }

  reasons.push(`audited window: ${decisions.length} decisions, ${executions.length} executions, ${outcomes.length} outcomes, ${behaviors.length} behaviours, ${flags.length} integrity flag(s)`);

  return {
    totalDecisions: decisions.length,
    totalBlockedSetups: blockedSetups,
    totalExecutions: executions.length,
    totalOutcomes: outcomes.length,
    decisionsWithoutOutcome,
    outcomesWithoutDecision,
    overrideEvents: behaviors.filter((b) => b.behaviorKind === "OVERRIDE_BLOCK" || b.behaviorKind === "OVERRIDE_RISK").length,
    integrityFlagCount: flags.length,
    integrityCriticalCount,
    integrityByCategory,
    reasons, blockers,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Trader DNA — profiles a human operator's behaviour patterns over time so
// downstream learners can model when a human is helping vs hurting.
// ═══════════════════════════════════════════════════════════════════════════
export interface TraderDnaProfile {
  totalActions: number;
  overrideBlockCount: number;             // how often human overrides DENIED
  overrideRiskCount: number;              // how often human overrides risk
  manualOpenCount: number;
  manualCloseCount: number;
  killSwitchCount: number;
  paramChangeCount: number;
  // Outcomes of trades that were touched by the operator:
  touchedTrades: number;
  touchedTradesWon: number;
  touchedTradesLost: number;
  touchedWinRate01: number;
  reasons: string[];
  blockers: string[];
}

export async function summarizeTraderDna(
  ports: VaultQueryPorts,
  q: VaultQuery = {},
): Promise<TraderDnaProfile> {
  const reasons: string[] = [];
  const blockers: string[] = [];
  const behaviors = await ports.behavior.list(q);
  const touchedIds = new Set<string>();
  for (const b of behaviors) if (b.targetTradeId) touchedIds.add(b.targetTradeId);

  let touchedWon = 0; let touchedLost = 0;
  for (const tid of touchedIds) {
    const o = await ports.outcome.byTrade(tid);
    if (!o) continue;
    if (o.pnlR > 0) touchedWon += 1; else touchedLost += 1;
  }
  const touchedTrades = touchedWon + touchedLost;
  const profile: TraderDnaProfile = {
    totalActions: behaviors.length,
    overrideBlockCount: behaviors.filter((b) => b.behaviorKind === "OVERRIDE_BLOCK").length,
    overrideRiskCount:  behaviors.filter((b) => b.behaviorKind === "OVERRIDE_RISK").length,
    manualOpenCount:    behaviors.filter((b) => b.behaviorKind === "MANUAL_OPEN").length,
    manualCloseCount:   behaviors.filter((b) => b.behaviorKind === "MANUAL_CLOSE").length,
    killSwitchCount:    behaviors.filter((b) => b.behaviorKind === "KILL_SWITCH_PRESSED").length,
    paramChangeCount:   behaviors.filter((b) => b.behaviorKind === "PARAM_CHANGE").length,
    touchedTrades, touchedTradesWon: touchedWon, touchedTradesLost: touchedLost,
    touchedWinRate01: touchedTrades > 0 ? touchedWon / touchedTrades : 0,
    reasons, blockers,
  };
  if (behaviors.length === 0) {
    blockers.push(`no behaviour records in window — Trader DNA profile is empty`);
  } else {
    reasons.push(`profiled ${behaviors.length} actions across ${touchedTrades} touched trades, win-rate ${profile.touchedWinRate01.toFixed(3)}`);
  }
  return profile;
}

// ═══════════════════════════════════════════════════════════════════════════
// Strategy improvement proposals — turns observed performance into
// actionable, structured suggestions. ADVISORY ONLY — Risk Governor and
// the lifecycle/promotion engines retain final say.
// ═══════════════════════════════════════════════════════════════════════════
export interface StrategyImprovementProposal {
  strategyId: StrategyId;
  proposalKind:
    | "REDUCE_SIZE" | "PAUSE_STRATEGY" | "RESTRICT_REGIME"
    | "INVESTIGATE_EXECUTION" | "RECALIBRATE_CONFIDENCE" | "MAINTAIN";
  rationale: string;
  reasons: string[];
  blockers: string[];
}

export const STRATEGY_IMPROVEMENT_TUNING = {
  pauseExpectancyRBelow: -0.05,
  reduceSizeWinRateBelow: 0.40,
  executionMeanSlippagePipsHigh: 2.0,
  executionMeanLatencyMsHigh: 400,
  minTradesForProposal: 30,
} as const;

export async function proposeStrategyImprovements(
  strategyId: StrategyId,
  ports: VaultQueryPorts,
  q: VaultQuery = {},
): Promise<StrategyImprovementProposal[]> {
  const proposals: StrategyImprovementProposal[] = [];
  const summary = await summarize({ ...q, strategyId }, ports);

  if (summary.trades < STRATEGY_IMPROVEMENT_TUNING.minTradesForProposal) {
    proposals.push({
      strategyId, proposalKind: "MAINTAIN",
      rationale: `only ${summary.trades} trades — keep observing`,
      reasons: [`samples ${summary.trades} < min ${STRATEGY_IMPROVEMENT_TUNING.minTradesForProposal}`],
      blockers: [`under-sampled — proposal is informational only`],
    });
    return proposals;
  }

  if (summary.expectancyR <= STRATEGY_IMPROVEMENT_TUNING.pauseExpectancyRBelow) {
    proposals.push({
      strategyId, proposalKind: "PAUSE_STRATEGY",
      rationale: `expectancyR ${summary.expectancyR.toFixed(3)} ≤ pause floor`,
      reasons: [`pause floor ${STRATEGY_IMPROVEMENT_TUNING.pauseExpectancyRBelow}`],
      blockers: [`Risk Governor + lifecycle engine retain final say`],
    });
  } else if (summary.winRate01 < STRATEGY_IMPROVEMENT_TUNING.reduceSizeWinRateBelow) {
    proposals.push({
      strategyId, proposalKind: "REDUCE_SIZE",
      rationale: `winRate ${(summary.winRate01 * 100).toFixed(1)}% below comfort zone`,
      reasons: [`winRate floor ${STRATEGY_IMPROVEMENT_TUNING.reduceSizeWinRateBelow}`],
      blockers: [],
    });
  } else {
    proposals.push({
      strategyId, proposalKind: "MAINTAIN",
      rationale: `expectancyR ${summary.expectancyR.toFixed(3)}, winRate ${(summary.winRate01 * 100).toFixed(1)}% — within comfort zone`,
      reasons: [], blockers: [],
    });
  }

  if (summary.meanSlippagePips > STRATEGY_IMPROVEMENT_TUNING.executionMeanSlippagePipsHigh
      || summary.meanLatencyMs > STRATEGY_IMPROVEMENT_TUNING.executionMeanLatencyMsHigh) {
    proposals.push({
      strategyId, proposalKind: "INVESTIGATE_EXECUTION",
      rationale: `mean slippage ${summary.meanSlippagePips.toFixed(2)} pips, latency ${summary.meanLatencyMs.toFixed(0)}ms`,
      reasons: [
        `slippage tol ${STRATEGY_IMPROVEMENT_TUNING.executionMeanSlippagePipsHigh}`,
        `latency tol ${STRATEGY_IMPROVEMENT_TUNING.executionMeanLatencyMsHigh}`,
      ],
      blockers: [],
    });
  }
  return proposals;
}

// ── helpers ────────────────────────────────────────────────────────────────
async function summarize(
  q: VaultQuery,
  ports: VaultQueryPorts,
): Promise<PerformanceSummary> {
  const outcomes   = await ports.outcome.list(q);
  const executions = await ports.execution.list(q);
  let wins = 0; let losses = 0; let pnlSumR = 0;
  for (const o of outcomes) {
    if (o.pnlR > 0) wins += 1; else losses += 1;
    pnlSumR += o.pnlR;
  }
  let slipSum = 0; let latSum = 0;
  for (const e of executions) { slipSum += Math.abs(e.slippagePips); latSum += e.latencyMs; }
  const trades = outcomes.length;
  return {
    trades, wins, losses,
    winRate01: trades > 0 ? wins / trades : 0,
    expectancyR: trades > 0 ? pnlSumR / trades : 0,
    meanSlippagePips: executions.length > 0 ? slipSum / executions.length : 0,
    meanLatencyMs:    executions.length > 0 ? latSum  / executions.length : 0,
  };
}

function stripAgent(q: VaultQuery): VaultQuery {
  // When grading an agent we don't want to also filter records by .agentId
  // envelope (decisions usually carry no agentId; the vote is what matters).
  const { agentId: _ignored, ...rest } = q;
  void _ignored;
  return rest;
}

// satisfy unused-import linters when they exist
void (null as unknown as DecisionTruthRecord | OutcomeTruthRecord);

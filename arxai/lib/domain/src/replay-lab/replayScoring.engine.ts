// ═══════════════════════════════════════════════════════════════════════════
// Replay Scoring
//
// Grades a replay across 8 dimensions:
//   • decisionQuality01     — judge alignment with simulated outcome
//   • executionQuality01    — from execution replay
//   • disciplineQuality01   — from trader DNA replay
//   • riskQuality01         — stop placement + R:R + sizing vs balance
//   • expectancyImpactR     — outcome rMultiple
//   • survivalImpact01      — drawdown contribution within risk budget
//   • agentAccuracy01       — from agent replay
//   • confidenceCalibration01 — from agent replay (1 − meanBrier)
//
// Returns a composite overall01.
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

import type { ReplayScores, ReplaySnapshot, TradeOutcome } from "./replay.types";
import type { AgentReplayReport } from "./agentReplay.engine";
import type { JudgeReplayReport } from "./judgeReplay.engine";
import type { ExecutionReplayReport } from "./executionReplay.engine";
import type { TraderDNAReplayReport } from "./traderDNAReplay.engine";

export interface ScoringInputs {
  snapshot: ReplaySnapshot;
  outcome: TradeOutcome;
  agent: AgentReplayReport;
  judge: JudgeReplayReport;
  execution: ExecutionReplayReport;
  dna: TraderDNAReplayReport;
}

export function scoreReplay(inputs: ScoringInputs): ReplayScores {
  const { snapshot, outcome, agent, judge, execution, dna } = inputs;

  // Decision: judge correctness + agent accuracy weight
  const decisionQuality01 = clamp01((judge.verdictCorrect ? 0.6 : 0.2) + agent.averageAccuracy01 * 0.4);

  // Risk quality: R:R intent, sizing vs balance, stop discipline
  const riskQuality01 = computeRiskQuality(snapshot);

  // Expectancy: signed R multiple
  const expectancyImpactR = round2(outcome.rMultiple);

  // Survival: how much of risk budget consumed by this trade's loss (0=no loss, 1=blew budget)
  const survivalImpact01 = computeSurvivalImpact(snapshot, outcome);

  const overall = clamp01(
    decisionQuality01      * 0.20 +
    execution.executionQuality01 * 0.15 +
    dna.disciplineQuality01      * 0.15 +
    riskQuality01                * 0.15 +
    clamp01(0.5 + expectancyImpactR / 4) * 0.15 +
    (1 - survivalImpact01)       * 0.10 +
    agent.averageAccuracy01      * 0.05 +
    agent.averageCalibration01   * 0.05,
  );

  return {
    decisionQuality01:    round2(decisionQuality01),
    executionQuality01:   round2(execution.executionQuality01),
    disciplineQuality01:  round2(dna.disciplineQuality01),
    riskQuality01:        round2(riskQuality01),
    expectancyImpactR,
    survivalImpact01:     round2(survivalImpact01),
    agentAccuracy01:      round2(agent.averageAccuracy01),
    confidenceCalibration01: round2(agent.averageCalibration01),
    overall01:            round2(overall),
  };
}

function computeRiskQuality(snapshot: ReplaySnapshot): number {
  const intent = snapshot.intent;
  if (!intent) return 0.5;
  const risk = Math.abs(intent.entryPrice - intent.stopLoss);
  const reward = intent.takeProfit !== null && intent.takeProfit !== undefined
    ? Math.abs(intent.takeProfit - intent.entryPrice) : risk;
  const rr = risk > 0 ? reward / risk : 0;
  // Reward 1:1.5+ as good, 1:1 fair, <1:1 poor
  const rrScore = clamp01(rr / 2);
  // Sizing: per-trade risk vs maxAllowedRiskPct
  const balance = snapshot.riskState.accountBalance || 1;
  const dollarRisk = risk * intent.lotSize;
  const riskPct = (dollarRisk / balance) * 100;
  const sizingScore = clamp01(1 - Math.max(0, riskPct - snapshot.riskState.maxAllowedRiskPct) / Math.max(1, snapshot.riskState.maxAllowedRiskPct));
  return clamp01(rrScore * 0.6 + sizingScore * 0.4);
}

function computeSurvivalImpact(snapshot: ReplaySnapshot, outcome: TradeOutcome): number {
  if (outcome.pnl >= 0) return 0;
  const balance = snapshot.riskState.accountBalance || 1;
  const lossPct = Math.abs(outcome.pnl) / balance * 100;
  // Treat 100% of maxAllowedRiskPct as 1.0 survival impact
  const cap = Math.max(0.5, snapshot.riskState.maxAllowedRiskPct);
  return clamp01(lossPct / cap);
}

function clamp01(n: number) { return Math.max(0, Math.min(1, n)); }
function round2(n: number) { return Math.round(n * 100) / 100; }

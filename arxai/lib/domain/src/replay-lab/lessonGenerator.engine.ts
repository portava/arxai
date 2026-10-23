// ═══════════════════════════════════════════════════════════════════════════
// Lesson Generator
//
// Converts a completed replay (snapshot + result + sub-reports) into a
// list of structured lessons that the Black Box Vault can store and that
// downstream systems (agent performance, Trader DNA, calibration,
// validation pipeline) can act on.
//
// Pure. Always evidence-based and neutral.
// ═══════════════════════════════════════════════════════════════════════════

import type {
  ReplayLesson, ReplayResult, ReplaySnapshot, TradeOutcome,
} from "./replay.types";
import type { AgentReplayReport } from "./agentReplay.engine";
import type { JudgeReplayReport } from "./judgeReplay.engine";
import type { ExecutionReplayReport } from "./executionReplay.engine";
import type { TraderDNAReplayReport } from "./traderDNAReplay.engine";
import type { OverrideReplayResult } from "./overrideReplay.engine";

export interface LessonInputs {
  snapshot: ReplaySnapshot;
  result: ReplayResult;
  outcome: TradeOutcome;
  agent: AgentReplayReport;
  judge: JudgeReplayReport;
  execution: ExecutionReplayReport;
  dna: TraderDNAReplayReport;
  override?: OverrideReplayResult | null;
}

export function generateLessons(inputs: LessonInputs): ReplayLesson[] {
  const lessons: ReplayLesson[] = [];
  const { snapshot, outcome, agent, judge, execution, dna, override } = inputs;
  const win  = outcome.status === "CLOSED_WIN" || outcome.status === "TARGET_HIT";
  const loss = outcome.status === "CLOSED_LOSS" || outcome.status === "STOPPED_OUT";

  // Agents
  const overconfidentLosers   = agent.perAgent.filter(p => !p.correct && p.confidence01 >= 0.75);
  const underconfidentWinners = agent.perAgent.filter(p =>  p.correct && p.confidence01 <= 0.40);
  if (overconfidentLosers.length) {
    lessons.push({
      kind: "AGENT_OVERCONFIDENT",
      severity: overconfidentLosers.length >= 3 ? "HIGH" : "MEDIUM",
      evidence: { agents: overconfidentLosers.map(a => a.agentId), count: overconfidentLosers.length },
      affectsAgents: overconfidentLosers.map(a => a.agentId),
      affectsCalibration: true,
      affectsValidationPipeline: true,
      affectsTraderDNA: false,
      neutralLanguage: `${overconfidentLosers.length} agent(s) voted with ≥0.75 confidence on the losing side.`,
    });
  }
  if (underconfidentWinners.length) {
    lessons.push({
      kind: "AGENT_UNDERCONFIDENT",
      severity: "LOW",
      evidence: { agents: underconfidentWinners.map(a => a.agentId), count: underconfidentWinners.length },
      affectsAgents: underconfidentWinners.map(a => a.agentId),
      affectsCalibration: true,
      affectsValidationPipeline: false,
      affectsTraderDNA: false,
      neutralLanguage: `${underconfidentWinners.length} agent(s) were correct but at ≤0.40 confidence.`,
    });
  }
  if (agent.averageCalibration01 < 0.55 && agent.sample >= 3) {
    lessons.push({
      kind: "CONFIDENCE_MISCALIBRATED",
      severity: agent.averageCalibration01 < 0.40 ? "HIGH" : "MEDIUM",
      evidence: { calibration01: agent.averageCalibration01, sample: agent.sample },
      affectsCalibration: true, affectsValidationPipeline: true,
      affectsAgents: agent.perAgent.map(a => a.agentId),
      affectsTraderDNA: false,
      neutralLanguage: `Aggregate calibration ${agent.averageCalibration01.toFixed(2)} below 0.55 baseline.`,
    });
  }

  // Judge
  if (judge.blockMissedOpportunity) {
    lessons.push({
      kind: "BLOCK_WAS_WRONG",
      severity: "MEDIUM",
      evidence: { reasons: judge.notes },
      affectsCalibration: true, affectsValidationPipeline: true,
      affectsTraderDNA: false, affectsAgents: [],
      neutralLanguage: `BLOCK verdict on a setup that would have won.`,
    });
  } else if (judge.decision === "BLOCK" && loss) {
    lessons.push({
      kind: "BLOCK_WAS_CORRECT",
      severity: "INFO",
      evidence: { reasons: judge.notes },
      affectsCalibration: false, affectsValidationPipeline: false,
      affectsTraderDNA: false, affectsAgents: [],
      neutralLanguage: `BLOCK verdict avoided a losing trade.`,
    });
  }

  // Override
  if (override?.overrideHelped) {
    lessons.push({
      kind: "OVERRIDE_HELPED", severity: "INFO",
      evidence: { rDelta: override.rDelta, systemDecision: override.systemDecision },
      affectsTraderDNA: true, affectsCalibration: true,
      affectsValidationPipeline: false, affectsAgents: [],
      neutralLanguage: `Override outperformed system path by ${override.rDelta}R.`,
    });
  }
  if (override?.overrideHurt) {
    lessons.push({
      kind: "OVERRIDE_HURT",
      severity: Math.abs(override.rDelta) >= 1 ? "HIGH" : "MEDIUM",
      evidence: { rDelta: override.rDelta, systemDecision: override.systemDecision },
      affectsTraderDNA: true, affectsCalibration: true,
      affectsValidationPipeline: true, affectsAgents: [],
      neutralLanguage: `Override underperformed system path by ${Math.abs(override.rDelta)}R.`,
    });
  }

  // Execution
  if (execution.executionQuality01 < 0.60) {
    lessons.push({
      kind: "EXECUTION_DEGRADED",
      severity: execution.executionQuality01 < 0.40 ? "HIGH" : "MEDIUM",
      evidence: { quality01: execution.executionQuality01, notes: execution.notes },
      affectsValidationPipeline: true,
      affectsAgents: [], affectsTraderDNA: false, affectsCalibration: false,
      neutralLanguage: `Execution quality ${execution.executionQuality01.toFixed(2)}; ${execution.notes.join("; ")}.`,
    });
  }

  // DNA / discipline — direction inferred from signed deviation, not just
  // magnitude. Lot above baseline = AGGRESSIVE; lot below baseline =
  // CONSERVATIVE. Without the actual lot value we cannot label direction,
  // so we skip the lesson rather than guess.
  if (dna.sizeDeviationFromBaseline >= 0.5 && dna.baselineMature && snapshot.intent) {
    const lot = snapshot.intent.lotSize;
    const baseLot = snapshot.traderDNA.baselineLot || 1;
    const tooAggressive = lot > baseLot;
    lessons.push({
      kind: tooAggressive ? "SIZE_TOO_AGGRESSIVE" : "SIZE_TOO_CONSERVATIVE",
      severity: dna.sizeDeviationFromBaseline >= 1.5 ? "HIGH" : "MEDIUM",
      evidence: {
        deviation: dna.sizeDeviationFromBaseline,
        lotSize: lot,
        baselineLot: baseLot,
        direction: tooAggressive ? "ABOVE_BASELINE" : "BELOW_BASELINE",
      },
      affectsTraderDNA: true,
      affectsAgents: [], affectsCalibration: false, affectsValidationPipeline: false,
      neutralLanguage:
        `Size ${(dna.sizeDeviationFromBaseline*100).toFixed(0)}% ${tooAggressive ? "above" : "below"} baseline (lot ${lot} vs baseline ${baseLot}).`,
    });
  }
  if (dna.disciplineScore01 < 0.40 && dna.baselineMature) {
    lessons.push({
      kind: "DNA_DRIFT_OBSERVED",
      severity: dna.disciplineScore01 < 0.25 ? "HIGH" : "MEDIUM",
      evidence: { disciplineScore01: dna.disciplineScore01, behaviorRiskScore01: dna.behaviorRiskScore01 },
      affectsTraderDNA: true, affectsValidationPipeline: true,
      affectsCalibration: false, affectsAgents: [],
      neutralLanguage: `Discipline ${dna.disciplineScore01.toFixed(2)} below 0.40 at decision time.`,
    });
  }

  // Stops / TPs (heuristic from outcome)
  if (snapshot.intent && outcome.status === "STOPPED_OUT") {
    const swingRange = approxSwingRange(snapshot);
    const stopDist = Math.abs(snapshot.intent.entryPrice - snapshot.intent.stopLoss);
    if (swingRange > 0 && stopDist < swingRange * 0.4) {
      lessons.push({
        kind: "STOP_TOO_TIGHT", severity: "MEDIUM",
        evidence: { stopDist: round2(stopDist), swingRange: round2(swingRange) },
        affectsTraderDNA: true, affectsValidationPipeline: false,
        affectsCalibration: false, affectsAgents: [],
        neutralLanguage: `Stop distance ${stopDist.toFixed(4)} is below 40% of observed range ${swingRange.toFixed(4)}.`,
      });
    }
  }
  if (snapshot.intent && outcome.status === "TIME_EXIT" && win === false && loss === false) {
    if (snapshot.intent.takeProfit !== null && snapshot.intent.takeProfit !== undefined) {
      lessons.push({
        kind: "TP_TOO_GREEDY", severity: "INFO",
        evidence: { takeProfit: snapshot.intent.takeProfit, exitPrice: outcome.exitPrice },
        affectsTraderDNA: true, affectsValidationPipeline: false,
        affectsCalibration: false, affectsAgents: [],
        neutralLanguage: `Take-profit not reached before time exit; consider tighter target.`,
      });
    }
  }

  return lessons;
}

function approxSwingRange(snapshot: ReplaySnapshot): number {
  const ranges = snapshot.candles.map(c => c.high - c.low);
  if (!ranges.length) return 0;
  const sorted = [...ranges].sort((a,b) => a - b);
  return sorted[Math.floor(sorted.length * 0.75)];
}
function round2(n: number) { return Math.round(n * 100) / 100; }

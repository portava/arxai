// Agent Ecosystem — Layer 2: truth-review scoring engine (§5).
//
// Given a LOCKED prediction and its realized outcome, grade the agent across
// six dimensions: Decision Quality, Outcome, Protection, Speed, Usefulness,
// Calibration. PURE (no DB, no IO). The persistence layer (api-server) feeds
// row-shaped data in and writes an append-only agent_prediction_reviews row out.
//
// SAFETY / SCOPE:
//   - OBSERVATION ONLY. Scoring a past prediction NEVER places, modifies, or
//     closes a trade and never touches the 16-gate live pipeline.
//   - Profit alone is NEVER a reward (§5): a winning-but-reckless prediction
//     (e.g. no stop defined) can score poorly; a clean, well-protected losing
//     setup can score decently. The composite weights Protection and Decision
//     Quality so a lucky reckless win cannot out-score a disciplined loss.
//   - The no-trade reward weight is EQUAL to the trade reward weight (§14):
//     REWARD_CATALOG.correct_no_trade === REWARD_CATALOG.profitable_trade_taken.
//
// Reuses gradeAgent (vote × outcome alignment) for the Outcome sub-score and
// calibrate() for the Calibration sub-score, rather than re-deriving them.

import type { AgentVote } from "../agentVote.types";
import { gradeAgent } from "../accountability/agentScoring.engine";
import { calibrate } from "../accountability/confidenceCalibration.engine";
import type {
  AgentPerformanceRecord, CouncilAgentGrade, TradeOutcome,
} from "../accountability/agentPerformance.types";

export type ReviewRealizedOutcome =
  | "WIN" | "LOSS" | "BREAKEVEN"
  | "NO_TRADE_CORRECT" | "NO_TRADE_MISSED"
  | "EXPIRED" | "UNRESOLVED";

// Reward / penalty catalogs (points applied to the 0-100 sub-scores). The
// no-trade reward is deliberately equal to the trade reward (§14).
export const REWARD_CATALOG = {
  clean_setup_structure: 10,
  good_rr: 10,
  profitable_trade_taken: 15,
  correct_no_trade: 15,        // EQUAL to profitable_trade_taken (§14)
  blocked_bad_setup: 15,
  fast_useful_output: 8,
  correct_step_back: 10,
  clear_reasoning: 8,
  clean_process_despite_loss: 8,
  capital_protected: 12,
  stop_defined: 12,
} as const;

export const PENALTY_CATALOG = {
  reckless_win_no_stop: 20,
  ignored_sr: 15,
  unrealistic_target: 12,
  duplicate_analysis: 10,
  repeated_corrected_mistake: 25,
  no_stop_defined: 15,
  late_chase: 12,
  overconfident_loss: 12,
} as const;

export type RewardTag = keyof typeof REWARD_CATALOG;
export type PenaltyTag = keyof typeof PENALTY_CATALOG;

export interface ReviewablePrediction {
  predictionId: string;
  agentId: number;
  decision: string;                 // approve | caution | reject | no_trade | observe
  direction: string | null;         // BUY | SELL | NONE
  confidenceScore: number;          // 0-100
  slSuggestion: number | null;
  tpSuggestion: number | null;
  entryZone: string | null;
  invalidationZone: string | null;
  reasoningSummary: string | null;
  responseMs?: number | null;       // signal -> prediction latency, if known
  respectedSR?: boolean | null;
  isDuplicateAnalysis?: boolean | null;
  repeatedCorrectedMistake?: boolean | null;
  correctStepBack?: boolean | null; // stepped back AND the setup later stalled
  lateChase?: boolean | null;       // entered late / chased
}

export interface ReviewOutcomeInput {
  realizedOutcome: ReviewRealizedOutcome;
  realizedPnlR: number | null;
}

export interface TradeReviewResult {
  decisionQuality: number;          // 0-100
  outcomeScore: number;             // 0-100
  protectionScore: number;          // 0-100
  speedScore: number;               // 0-100
  usefulnessScore: number;          // 0-100
  calibrationScore: number;         // 0-100
  scoreDelta: number;               // -2..+2 composite trust delta
  grade: CouncilAgentGrade;
  rewardTags: RewardTag[];
  penaltyTags: PenaltyTag[];
  rationale: string;
  realizedOutcome: ReviewRealizedOutcome;
  realizedPnlR: number | null;
}

const clamp01to100 = (n: number): number => Math.max(0, Math.min(100, n));

// Composite weighting — Protection and Decision Quality dominate so that a
// reckless win cannot out-score a disciplined loss (§5).
const WEIGHTS = {
  decisionQuality: 0.25, outcome: 0.15, protection: 0.25,
  speed: 0.10, usefulness: 0.10, calibration: 0.15,
} as const;

function gradeFromScore(score: number): CouncilAgentGrade {
  if (score >= 1.5) return "A";
  if (score >= 0.5) return "B";
  if (score > -0.5) return "C";
  if (score > -1.5) return "D";
  return "F";
}

function decisionToVote(decision: string, confidence01: number): AgentVote {
  const strong = confidence01 >= 0.7;
  switch (decision) {
    case "approve": return strong ? "STRONG_FOR" : "FOR";
    case "reject":
    case "no_trade": return strong ? "STRONG_AGAINST" : "AGAINST";
    case "caution":
    case "observe":
    default: return "NEUTRAL";
  }
}

function realizedToTradeOutcome(o: ReviewRealizedOutcome): TradeOutcome {
  switch (o) {
    case "WIN": return "WIN";
    case "LOSS": return "LOSS";
    case "BREAKEVEN": return "BREAKEVEN";
    case "NO_TRADE_CORRECT": return "BLOCKED_CORRECTLY";
    case "NO_TRADE_MISSED": return "BLOCKED_WRONGLY";
    default: return "SKIPPED";
  }
}

function speedFromMs(ms: number | null | undefined): number {
  if (ms == null) return 50;
  if (ms <= 500) return 90;
  if (ms <= 1500) return 78;
  if (ms <= 3000) return 62;
  if (ms <= 6000) return 46;
  return 32;
}

/**
 * Grade one locked prediction against its realized outcome. `calibrationHistory`
 * is this agent's prior performance records (used only for the Calibration
 * sub-score); pass [] when unknown.
 */
export function scoreTradeReview(args: {
  prediction: ReviewablePrediction;
  outcome: ReviewOutcomeInput;
  calibrationHistory?: ReadonlyArray<AgentPerformanceRecord>;
  now: Date;
}): TradeReviewResult {
  const { prediction: p, outcome, now } = args;
  const confidence01 = Math.max(0, Math.min(1, p.confidenceScore / 100));
  const tradeOutcome = realizedToTradeOutcome(outcome.realizedOutcome);
  const isNoTradeDecision = p.decision === "no_trade" || p.decision === "reject";
  const isTradeDecision = p.decision === "approve" || p.decision === "caution";

  // ── Outcome sub-score: reuse gradeAgent's alignment maths ─────────────────
  const perf: AgentPerformanceRecord = gradeAgent({
    agentId: String(p.agentId), agentName: String(p.agentId),
    decisionId: p.predictionId,
    vote: decisionToVote(p.decision, confidence01),
    confidence01, outcome: tradeOutcome,
    pnlR: outcome.realizedPnlR, now,
  });
  const outcomeScore = clamp01to100(((perf.scoreDelta + 2) / 4) * 100);

  // ── Calibration sub-score: reuse calibrate() over history + this record ────
  const history = [...(args.calibrationHistory ?? []), perf];
  const report = calibrate({ agentId: String(p.agentId), records: history, now });
  const calibrationScore = report.sampleSize >= 10
    ? clamp01to100(100 - report.meanAbsError01 * 200)   // 0.15 err -> 70
    : 50;

  // ── Catalog-driven sub-scores: start neutral, apply rewards/penalties ─────
  const rewardTags: RewardTag[] = [];
  const penaltyTags: PenaltyTag[] = [];
  let decisionQuality = 50, protection = 50, usefulness = 50;
  let speed = speedFromMs(p.responseMs);

  const reward = (tag: RewardTag, dim: "dq" | "pr" | "us" | "sp") => {
    rewardTags.push(tag);
    const pts = REWARD_CATALOG[tag];
    if (dim === "dq") decisionQuality += pts;
    else if (dim === "pr") protection += pts;
    else if (dim === "us") usefulness += pts;
    else speed += pts;
  };
  const penalize = (tag: PenaltyTag, dims: Array<"dq" | "pr" | "us" | "sp">) => {
    penaltyTags.push(tag);
    const pts = PENALTY_CATALOG[tag];
    for (const dim of dims) {
      if (dim === "dq") decisionQuality -= pts;
      else if (dim === "pr") protection -= pts;
      else if (dim === "us") usefulness -= pts;
      else speed -= pts;
    }
  };

  const hasStop = p.slSuggestion != null;
  const hasTarget = p.tpSuggestion != null;
  const cleanStructure = hasStop && hasTarget && !!p.entryZone && !!p.invalidationZone;
  const won = outcome.realizedOutcome === "WIN";
  const lost = outcome.realizedOutcome === "LOSS";

  if (cleanStructure) reward("clean_setup_structure", "dq");
  if (hasStop) reward("stop_defined", "pr");
  else penalize("no_stop_defined", ["pr"]);

  if (p.reasoningSummary && p.reasoningSummary.trim().length >= 12) reward("clear_reasoning", "us");
  if ((p.responseMs ?? Infinity) <= 1500 && p.decision !== "observe") reward("fast_useful_output", "sp");
  if (p.correctStepBack) reward("correct_step_back", "dq");
  if (p.lateChase) penalize("late_chase", ["sp", "dq"]);
  if (p.respectedSR === false) penalize("ignored_sr", ["dq"]);
  if (p.isDuplicateAnalysis) penalize("duplicate_analysis", ["us"]);
  if (p.repeatedCorrectedMistake) penalize("repeated_corrected_mistake", ["dq"]);

  // No-trade rewards (weight EQUAL to trade rewards, §14).
  if (isNoTradeDecision && outcome.realizedOutcome === "NO_TRADE_CORRECT") {
    reward("correct_no_trade", "dq");
    reward("blocked_bad_setup", "pr");
    reward("capital_protected", "pr");
  }

  // Trade rewards / penalties.
  if (isTradeDecision && won) {
    reward("profitable_trade_taken", "us");
    if (hasTarget && (outcome.realizedPnlR ?? 0) >= 1.5) reward("good_rr", "dq");
    // Profit is NEVER a reward on its own — a win with no stop is reckless (§5).
    if (!hasStop) penalize("reckless_win_no_stop", ["pr", "dq"]);
  }
  if (isTradeDecision && lost) {
    if (cleanStructure && (outcome.realizedPnlR ?? -99) > -1.2) {
      reward("clean_process_despite_loss", "dq");   // disciplined loss scores decently
    }
    if (confidence01 >= 0.7) penalize("overconfident_loss", ["dq"]);
  }

  decisionQuality = clamp01to100(decisionQuality);
  protection = clamp01to100(protection);
  usefulness = clamp01to100(usefulness);
  speed = clamp01to100(speed);

  // ── Composite trust delta (-2..+2) and letter grade ──────────────────────
  const composite01 = (
    decisionQuality * WEIGHTS.decisionQuality +
    outcomeScore * WEIGHTS.outcome +
    protection * WEIGHTS.protection +
    speed * WEIGHTS.speed +
    usefulness * WEIGHTS.usefulness +
    calibrationScore * WEIGHTS.calibration
  ) / 100;
  const scoreDelta = Math.max(-2, Math.min(2, +((composite01 - 0.5) * 4).toFixed(3)));
  const grade = gradeFromScore(scoreDelta);

  const rationale =
    `decision=${p.decision} outcome=${outcome.realizedOutcome} ` +
    `dq=${decisionQuality.toFixed(0)} out=${outcomeScore.toFixed(0)} ` +
    `prot=${protection.toFixed(0)} spd=${speed.toFixed(0)} ` +
    `use=${usefulness.toFixed(0)} cal=${calibrationScore.toFixed(0)} ` +
    `→ score=${scoreDelta.toFixed(2)} grade=${grade}` +
    (rewardTags.length ? ` +[${rewardTags.join(",")}]` : "") +
    (penaltyTags.length ? ` -[${penaltyTags.join(",")}]` : "");

  return {
    decisionQuality, outcomeScore, protectionScore: protection,
    speedScore: speed, usefulnessScore: usefulness, calibrationScore,
    scoreDelta, grade, rewardTags, penaltyTags, rationale,
    realizedOutcome: outcome.realizedOutcome,
    realizedPnlR: outcome.realizedPnlR,
  };
}

// Rolling aggregate update — nudge the agent's stored 0-100 aggregate toward
// the new sub-score via an exponential moving average. PURE.
export function applyRollingAggregate(current: number, sub: number, alpha = 0.2): number {
  return +clamp01to100(current * (1 - alpha) + sub * alpha).toFixed(2);
}

export interface AggregateUpdate {
  qualityScore: number; speedScore: number; protectionScore: number;
  usefulnessScore: number; calibrationScore: number; trustScore: number;
}

/** Compute the agent's next rolling aggregates from a fresh review. PURE. */
export function nextAggregates(args: {
  current: {
    qualityScore: number; speedScore: number; protectionScore: number;
    usefulnessScore: number; calibrationScore: number; trustScore: number;
  };
  review: TradeReviewResult;
  alpha?: number;
}): AggregateUpdate {
  const { current, review, alpha } = args;
  const qualityScore = applyRollingAggregate(current.qualityScore, review.decisionQuality, alpha);
  const speedScore = applyRollingAggregate(current.speedScore, review.speedScore, alpha);
  const protectionScore = applyRollingAggregate(current.protectionScore, review.protectionScore, alpha);
  const usefulnessScore = applyRollingAggregate(current.usefulnessScore, review.usefulnessScore, alpha);
  const calibrationScore = applyRollingAggregate(current.calibrationScore, review.calibrationScore, alpha);
  // Trust = blended health of the other five (recomputed, not drifted).
  const trustScore = +(
    (qualityScore + protectionScore + speedScore + usefulnessScore + calibrationScore) / 5
  ).toFixed(2);
  return { qualityScore, speedScore, protectionScore, usefulnessScore, calibrationScore, trustScore };
}

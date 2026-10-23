import { z } from "zod/v4";

// ── Inputs ────────────────────────────────────────────────────────────────
//
// ClosedTradeRecord captures EVERYTHING the retrospective layer needs in
// one self-contained struct. Engines never reach back to live state — a
// retrospective is a pure function of what was recorded at trade close.

export const TradeDirectionSchema = z.enum(["BUY", "SELL"]);
export type TradeDirection = z.infer<typeof TradeDirectionSchema>;

export const ExitReasonSchema = z.enum([
  "TAKE_PROFIT",     // hit TP exactly
  "STOP_LOSS",       // hit SL exactly
  "TRAIL_STOP",      // trailed stop took us out
  "TIME_STOP",       // closed by max-duration rule
  "MANUAL_EXIT",     // operator pressed close
  "PARTIAL_THEN_CLOSE", // multi-leg exit, last leg recorded
  "EMERGENCY_KILL",  // kill-switch closed it
]);
export type ExitReason = z.infer<typeof ExitReasonSchema>;

export interface ClosedTradeOutcome {
  tradeId: string;
  symbol: string;
  direction: TradeDirection;
  entryPrice: number;
  exitPrice: number;
  stopLoss: number;             // initial SL at open (final SL captured separately if changed)
  finalStopLoss: number;        // SL at close — may differ from initial
  takeProfit: number | null;
  openedAt: string;
  closedAt: string;
  durationSeconds: number;
  lotSize: number;
  pnlR: number;                 // signed final R-multiple — the canonical outcome
  pnlMoney: number;             // signed money result
  exitReason: ExitReason;
}

export interface IntraTradeStats {
  maxFavorableExcursionR: number;       // peak gain seen during life
  maxAdverseExcursionR: number;         // worst drawdown seen during life (≤ 0)
  mfePeakAtFraction: number;            // when MFE peaked, in [0, 1] of duration
  // Was the exit close to the MFE peak (good timing) or far from it (left on table)?
  // Caller computes: pnlR / mfeR when mfeR > 0; else null.
  capturedFractionOfMfe: number | null;
}

export interface EntryConditionsSnapshot {
  spreadPipsAtEntry: number;
  volatilityAtEntry: number | null;
  sessionStress01AtEntry: number;       // 0..1
  // Was the market trending toward the trade direction in the bars before entry?
  shortTermBiasAlignedAtEntry: boolean | null;
}

// ── Per-agent record at entry ────────────────────────────────────────────
//
// Each entry in agentVerdicts is the agent's vote at entry time. The
// agent-scoring engine cross-checks each against the actual outcome
// direction (won/lost) to produce right/wrong scorecards.
export interface AgentVerdictAtEntry {
  agentId: string;
  agentName: string;
  agentDirection: TradeDirection | "ABSTAIN";   // "ABSTAIN" = didn't take a side
  agentConfidence: number;                       // 0..100
  agentReasonTags: string[];                     // free-form tags from the agent
}

export interface OriginalConsensusSnapshot {
  consensusVerdict: string;             // e.g. "EXECUTE", "REDUCE_SIZE"
  consensusConfidence: number;           // 0..100, blended
  consensusDirection: TradeDirection;
  agentVerdicts: AgentVerdictAtEntry[];
}

export interface RiskTakenSnapshot {
  riskMultiplierUsed: number;           // e.g. 1.0 = baseline, 2.0 = double
  riskAsPctOfBalance: number;           // 0..100
  maxAllowedRiskPct: number;            // ceiling at the time
  baselineRiskPct: number;              // policy baseline at the time
  // Stop distance in R-units of normal volatility — wider = riskier per pip.
  stopDistanceVolUnits: number | null;
}

// ── Trader behaviors during the trade ─────────────────────────────────────
//
// Free-form structured log of operator actions. Only the kinds that matter
// for retrospective scoring are enumerated; unknowns are tolerated as
// generic "OTHER" with a free-form description.
export const TraderBehaviorKindSchema = z.enum([
  "MANUAL_EARLY_EXIT",
  "MANUAL_STOP_TIGHTEN",
  "MANUAL_STOP_WIDEN_ATTEMPT",  // attempt — may have been refused by governor
  "MANUAL_STOP_WIDEN_APPLIED",  // actually went through
  "ADDED_TO_POSITION",
  "REDUCED_POSITION",
  "OVERRIDE_KILL_SWITCH",
  "IGNORED_EXIT_WARNING",
  "OTHER",
]);
export type TraderBehaviorKind = z.infer<typeof TraderBehaviorKindSchema>;

export interface TraderBehaviorEvent {
  kind: TraderBehaviorKind;
  atFraction: number;             // [0, 1] of trade duration
  description: string;
}

// ── Aggregate input ──────────────────────────────────────────────────────
export interface ClosedTradeRecord {
  outcome: ClosedTradeOutcome;
  intra: IntraTradeStats;
  entryConditions: EntryConditionsSnapshot;
  consensus: OriginalConsensusSnapshot;
  risk: RiskTakenSnapshot;
  behaviors: TraderBehaviorEvent[];
  now?: Date;
}

// ── Verdict statuses shared across reports ───────────────────────────────
export const QualityRatingSchema = z.enum(["GOOD", "MIXED", "POOR", "INSUFFICIENT_DATA"]);
export const CalibrationRatingSchema = z.enum([
  "WELL_CALIBRATED", "TOO_HIGH", "TOO_LOW", "INSUFFICIENT_DATA",
]);
export const RiskRatingSchema = z.enum([
  "APPROPRIATE", "TOO_LARGE", "TOO_SMALL", "INSUFFICIENT_DATA",
]);
export type QualityRating     = z.infer<typeof QualityRatingSchema>;
export type CalibrationRating = z.infer<typeof CalibrationRatingSchema>;
export type RiskRating        = z.infer<typeof RiskRatingSchema>;

// ── Q1: Was entry good? ──────────────────────────────────────────────────
export interface EntryVerdict {
  rating: QualityRating;
  score: number;                  // 0..100
  factors: {
    immediateMfeProgressR: number;        // MFE within first 25% of duration
    mae: number;                          // MAE-R magnitude
    spreadAtEntryNormality: number;       // 1.0 = normal; >1 = elevated
    biasAlignment: boolean | null;
  };
  reasons: string[];
}

// ── Q2: Was exit good? ───────────────────────────────────────────────────
export interface ExitVerdict {
  rating: QualityRating;
  capturedPctOfMfe: number | null;        // 0..100, null when no MFE
  exitedAtR: number;
  exitReason: ExitReason;
  leftOnTableR: number;                   // mfe − pnl, ≥ 0
  reasons: string[];
}

// ── Q3+Q4: Which agent was right / wrong? ────────────────────────────────
export interface AgentVerdictScore {
  agentId: string;
  agentName: string;
  agentDirection: TradeDirection | "ABSTAIN";
  agentConfidence: number;
  // Outcome-aligned score 0..100 — high when the agent's direction matched
  // the realized winning direction with strong confidence.
  alignmentScore: number;
  contribution: "HELPFUL" | "HARMFUL" | "NEUTRAL";
  reasons: string[];
}
export interface AgentScorecard {
  winningDirection: TradeDirection | "AMBIGUOUS";
  rightAgents: AgentVerdictScore[];
  wrongAgents: AgentVerdictScore[];
  abstainedAgents: AgentVerdictScore[];
  consensusWasCorrect: boolean | null;     // null when AMBIGUOUS
  reasons: string[];
}

// ── Q5: Was confidence too high? ─────────────────────────────────────────
export interface ConfidenceVerdict {
  rating: CalibrationRating;
  originalConfidence: number;
  outcomeOneIfWin: 0 | 1;
  // Calibration "gap" — positive = confident & lost; negative = unconfident & won.
  // Single-trade gap is one data point — verdict only fires on extremes.
  gap: number;
  reasons: string[];
}

// ── Q6: Was risk too large? ──────────────────────────────────────────────
export interface RiskVerdict {
  rating: RiskRating;
  riskTakenPct: number;
  suggestedRiskPct: number;          // what the policy + confidence would have justified
  riskMultiplierUsed: number;
  reasons: string[];
}

// ── Q7: Did trader behavior affect outcome? ──────────────────────────────
export interface BehaviorImpact {
  kind: TraderBehaviorKind;
  atFraction: number;
  impact: "HELPFUL" | "HARMFUL" | "NEUTRAL";
  reason: string;
}
export interface BehaviorVerdict {
  affected: boolean;
  netImpact: "HELPFUL" | "HARMFUL" | "NEUTRAL" | "NONE";
  events: BehaviorImpact[];
  reasons: string[];
}

// ── Q8: What should change next time? ────────────────────────────────────
export const RecommendationCategorySchema = z.enum([
  "ENTRY_FILTER", "EXIT_RULE", "AGENT_WEIGHTING", "CONFIDENCE_POLICY",
  "RISK_SIZING", "BEHAVIOR_DISCIPLINE", "NO_CHANGE",
]);
export type RecommendationCategory = z.infer<typeof RecommendationCategorySchema>;

export interface NextTimeRecommendation {
  category: RecommendationCategory;
  recommendation: string;
  basedOnVerdicts: string[];        // which verdict(s) drove this — citation chain
  priority: "HIGH" | "MEDIUM" | "LOW";
}
export interface NextTimeRecommendationsReport {
  recommendations: NextTimeRecommendation[];   // ordered by priority
  reasons: string[];
}

// ── Aggregate result ─────────────────────────────────────────────────────
export interface RetrospectiveResult {
  tradeId: string;
  evaluatedAt: string;
  entry: EntryVerdict;
  exit: ExitVerdict;
  agents: AgentScorecard;
  confidence: ConfidenceVerdict;
  risk: RiskVerdict;
  behavior: BehaviorVerdict;
  nextTime: NextTimeRecommendationsReport;
}

// ── Thresholds — single source of truth ──────────────────────────────────
export const RETROSPECTIVE_THRESHOLDS = {
  entry: {
    immediateProgressFraction: 0.25,    // first 25% of duration counts as "immediate"
    goodImmediateMfeR: 0.5,
    poorImmediateMfeR: 0.0,
    poorMaeR: 0.6,                      // MAE this deep within first 25% = bad timing
    elevatedSpreadRatio: 2.0,
  },
  exit: {
    goodCapturePct: 70,                 // captured ≥ 70% of MFE = good exit
    poorCapturePct: 30,
    leftOnTableR: 1.0,                  // ≥ 1R left on table = poor regardless
  },
  agents: {
    minConfidenceToCount: 30,           // < 30 confidence is essentially abstaining
    ambiguousPnlR: 0.25,                // |pnlR| ≤ 0.25 = AMBIGUOUS outcome direction
  },
  confidence: {
    overconfidentLossThreshold: 75,     // confidence ≥ 75 + lost = TOO_HIGH
    underconfidentWinThreshold: 45,     // confidence ≤ 45 + clean win = TOO_LOW
    cleanWinR: 1.5,
  },
  risk: {
    tooLargeMultiplier: 1.5,            // > 1.5× baseline + lost = TOO_LARGE
    tooSmallMultiplier: 0.6,            // < 0.6× baseline + clean win = TOO_SMALL
  },
} as const;

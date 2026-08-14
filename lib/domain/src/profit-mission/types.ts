// Profit Mission Phase 1 — shared types for the pure planning engines.
//
// These engines are PURE, DETERMINISTIC, and IO-FREE. They never read the
// clock, the DB, the network, or any global. Every time-dependent value is
// derived from an explicit `now` passed by the caller. They are advisory /
// display-only: nothing here can relax, override, or trigger any execution
// gate. They can only BLOCK (lower a verdict / add a warning), never unblock.

export type RiskProfile = "conservative" | "balanced" | "aggressive" | "extreme";

export type TimeframeUnit = "minutes" | "hours" | "days" | "weeks";

export interface TimeframeSpec {
  amount: number;
  unit: TimeframeUnit;
}

export type FeasibilityTier =
  | "Easy"
  | "Realistic"
  | "Challenging"
  | "Aggressive"
  | "Extreme"
  | "Unreasonable";

export type MissionType =
  | "steady_growth"
  | "standard_growth"
  | "accelerated_growth"
  | "high_risk_sprint"
  | "extreme_sprint"
  | "unrealistic";

export type UnitAwareMissionClass =
  | "Scalp"
  | "Extreme scalp"
  | "Unrealistic scalp"
  | "Intraday"
  | "High-risk intraday"
  | "Unrealistic intraday"
  | "Swing"
  | "Multi-day";

export type ConfidenceLabel = "low" | "medium" | "high";

/** Honest readiness of the market feed for the mission's symbols. */
export interface FeedReadiness {
  /** True only when a real, fresh feed is confirmed for assessment. */
  ready: boolean;
  /** Honest machine reason when not ready (e.g. "STALE_FEED", "NO_FEED"). */
  reason?: string | null;
}

export interface MissionMathInput {
  startingAmount: number;
  targetAmount: number;
  timeframeStartMs: number;
  timeframeEndMs: number;
  /** Current account value; defaults to startingAmount when omitted. */
  currentValue?: number;
  /** Caller-supplied clock (ms). PURE: never read internally. */
  nowMs: number;
}

export interface MissionMath {
  startingAmount: number;
  targetAmount: number;
  currentValue: number;

  requiredProfit: number;
  requiredReturnPct: number;
  remainingProfit: number;

  totalDays: number;
  tradingDays: number;
  elapsedDays: number;
  remainingDays: number;

  /** Simple (linear) pace targets. */
  requiredDailyProfit: number;
  requiredSessionProfit: number;
  requiredHourlyProfit: number;
  /** Compound (geometric) daily return needed to hit the target. */
  requiredDailyReturnPct: number;

  /** Progress so far (can be negative); plus a 0–100 clamped display value. */
  progressPct: number;
  progressPctClamped: number;
  timeElapsedPct: number;

  /** Realised pace so far vs the required daily pace. */
  currentDailyProfit: number;
  paceRatio: number;
  onTrack: boolean;

  /** Total timeframe in minutes (derived from endMs − startMs). */
  timeframeMinutes: number;
  /**
   * Required total return per hour (linear).
   * i.e. requiredReturnPct / (timeframeMinutes / 60).
   * 0 when timeframe is zero.
   */
  requiredReturnPerHourPct: number;
  /**
   * Required daily-equivalent return % = requiredReturnPerHourPct × 24.
   * Shows the annualized pace at the short-mission rate.
   */
  requiredDailyEquivalentReturnPct: number;

  /** True when the inputs are degenerate (target ≤ starting, no time, etc.). */
  invalid: boolean;
  invalidReasons: string[];
}

/**
 * Structured comparison of the user's selected risk profile vs the profile the
 * target's required pace actually demands. DISPLAY-ONLY — it can explain why a
 * target is harder than the chosen profile assumes, but it never relaxes or
 * triggers any execution gate.
 */
export interface RiskProfileMismatch {
  /** The profile the user picked. */
  selected: RiskProfile;
  /** The profile the required daily pace demands. */
  required: RiskProfile;
  /** True when the selected profile is below what the target requires. */
  mismatch: boolean;
  /** Plain-language explanation when mismatched; null otherwise. */
  explanation: string | null;
}

export interface FeasibilityVerdict {
  tier: FeasibilityTier;
  /** 0–100; higher = more feasible. */
  feasibilityScore: number;
  /** 0–100; higher = more risk. */
  riskScore: number;
  recommendedRiskProfile: RiskProfile;
  missionType: MissionType;
  warnings: string[];
  explanation: string;
  /** Total return % the target needs (discrete field for the UI, also in math). */
  requiredReturnPct: number;
  /** Compound daily return % the target needs (discrete field for the UI). */
  requiredDailyReturnPct: number;
  /** Selected-vs-required risk profile comparison (always present). */
  riskProfileMismatch: RiskProfileMismatch;
  /** Feed-gated: mission START is blocked while false (draft still allowed). */
  canStart: boolean;
  startBlockReason: string | null;
  /** Always true — this is an advisory assessment, never a promise. */
  isEstimate: true;
  /**
   * Unit-aware mission classification layered on top of the feasibility tier.
   * Minute-based → Scalp / Extreme scalp / Unrealistic scalp.
   * Hour-based   → Intraday / High-risk intraday / Unrealistic intraday.
   * Day/week     → Swing / Multi-day.
   */
  unitAwareMissionClass: UnitAwareMissionClass;
}

export interface ScenarioProjection {
  /** Final account value estimate for this scenario. */
  endingValue: number;
  /** Profit/loss estimate vs starting amount. */
  profit: number;
  returnPct: number;
}

export interface MissionProbabilityScore {
  /** 0–100 estimate the target is reached within the timeframe. */
  targetHitProbability: number;
  /** 0–100 estimate of a meaningful drawdown along the way. */
  drawdownRisk: number;
  /** 0–100 estimate the mission ends short of the target. */
  failureProbability: number;

  projections: {
    best: ScenarioProjection;
    expected: ScenarioProjection;
    worst: ScenarioProjection;
  };

  confidence: ConfidenceLabel;
  /** Number of historical samples behind the estimate (0 in Phase 1). */
  sampleSize: number;
  sampleSizeWarnings: string[];

  /**
   * True when there is NO historical sample (sampleSize === 0): every value is a
   * forward mathematical planning projection, not a backtested probability.
   */
  planningProjectionOnly: boolean;
  /** Honest planning-projection note when projection-only; empty string otherwise. */
  planningProjectionNote: string;

  /** Always true — every number above is a labelled estimate, not a promise. */
  isEstimate: true;
  disclaimer: string;
}

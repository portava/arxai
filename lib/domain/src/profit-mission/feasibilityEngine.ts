// Profit Mission — pure feasibility engine (MissionFeasibilityEngine).
//
// Produces a FeasibilityVerdict (tier, 0–100 feasibility + risk scores,
// recommended risk profile, mission type, warnings, plain-language explanation)
// from the mission math + honest feed readiness.
//
// BLOCK-ONLY / FAIL-CLOSED: the engine can only lower a verdict, add warnings,
// or block START — it can NEVER relax or override any execution gate. A stale /
// missing feed blocks mission *start* but the mission can still be drafted.
// Invalid inputs fail closed to "Unreasonable" with canStart=false.

import type {
  FeasibilityTier,
  FeasibilityVerdict,
  FeedReadiness,
  MissionMath,
  MissionType,
  RiskProfile,
  RiskProfileMismatch,
  UnitAwareMissionClass,
} from "./types.js";

/** Ordered severity of the risk profiles (lower = more conservative). */
const RISK_PROFILE_RANK: Record<RiskProfile, number> = {
  conservative: 0,
  balanced: 1,
  aggressive: 2,
  extreme: 3,
};

function titleCaseProfile(p: RiskProfile): string {
  return p.charAt(0).toUpperCase() + p.slice(1);
}

/**
 * Compare the user's selected profile against the profile the required pace
 * demands. A mismatch (selected below required) is DISPLAY-ONLY — it explains
 * why the target is harder than the chosen profile assumes; it never relaxes a
 * gate. The exact copy is locked by the engine unit suite.
 */
function riskProfileMismatchFor(
  selected: RiskProfile,
  required: RiskProfile,
): RiskProfileMismatch {
  const mismatch = RISK_PROFILE_RANK[selected] < RISK_PROFILE_RANK[required];
  let explanation: string | null = null;
  if (mismatch) {
    explanation =
      `Your selected risk profile is ${titleCaseProfile(selected)}, but this ` +
      `target requires ${titleCaseProfile(required)} risk assumptions.`;
    if (required === "extreme") {
      explanation += " This mission exceeds normal aggressive planning limits.";
    }
  }
  return { selected, required, mismatch, explanation };
}

/** Undersized accounts below this floor get a warning (cost/spread drag). */
const UNDERSIZED_ACCOUNT_FLOOR = 100;
/** Timeframes shorter than this (in days) get an "impossibly short" warning. */
const SHORT_TIMEFRAME_DAYS = 1;
/** Minutes per hour (for short-timeframe zone boundaries). */
const MINUTES_PER_HOUR = 60;
/** Minutes per day. */
const MINUTES_PER_DAY = 1440;

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
function round(n: number): number {
  return Math.round(n);
}

/** Map the compound daily return needed → feasibility tier. */
function tierFor(requiredDailyReturnPct: number): FeasibilityTier {
  const d = requiredDailyReturnPct;
  if (d <= 0.3) return "Easy";
  if (d <= 1) return "Realistic";
  if (d <= 2) return "Challenging";
  if (d <= 5) return "Aggressive";
  if (d <= 10) return "Extreme";
  return "Unreasonable";
}

function missionTypeFor(tier: FeasibilityTier): MissionType {
  switch (tier) {
    case "Easy": return "steady_growth";
    case "Realistic": return "standard_growth";
    case "Challenging": return "accelerated_growth";
    case "Aggressive": return "high_risk_sprint";
    case "Extreme": return "extreme_sprint";
    case "Unreasonable": return "unrealistic";
  }
}

/**
 * Unit-aware mission classification layered on top of the feasibility tier.
 * Uses totalMinutes from the math to detect minute / hour / day+week zones.
 */
function unitAwareMissionClassFor(
  tier: FeasibilityTier,
  totalMinutes: number,
): UnitAwareMissionClass {
  if (totalMinutes < MINUTES_PER_HOUR) {
    if (tier === "Unreasonable") return "Unrealistic scalp";
    if (tier === "Extreme") return "Extreme scalp";
    return "Scalp";
  }
  if (totalMinutes < MINUTES_PER_DAY) {
    if (tier === "Unreasonable") return "Unrealistic intraday";
    if (tier === "Aggressive" || tier === "Extreme") return "High-risk intraday";
    return "Intraday";
  }
  if (totalMinutes >= MINUTES_PER_DAY * 7) return "Multi-day";
  return "Swing";
}

function recommendedRiskProfileFor(requiredDailyReturnPct: number): RiskProfile {
  const d = requiredDailyReturnPct;
  if (d <= 0.3) return "conservative";
  if (d <= 2) return "balanced";
  if (d <= 5) return "aggressive";
  return "extreme";
}

function explanationFor(
  tier: FeasibilityTier,
  m: MissionMath,
): string {
  const ret = m.requiredReturnPct.toFixed(1);
  const daily = m.requiredDailyReturnPct.toFixed(2);
  const days = Math.max(0, Math.round(m.totalDays));
  const base =
    `This target needs about a ${ret}% total return over ${days} day(s) — ` +
    `roughly ${daily}% per day at a compounding pace.`;
  switch (tier) {
    case "Easy":
      return `${base} This is a steady, low-pace target with room to spare.`;
    case "Realistic":
      return `${base} This is a standard target reachable with disciplined pace.`;
    case "Challenging":
      return `${base} This is an accelerated target that needs consistent execution.`;
    case "Aggressive":
      return `${base} This is a high-pace target carrying elevated possible loss.`;
    case "Extreme":
      return `${base} This is an extreme target with high possible loss; treat the estimate with caution.`;
    case "Unreasonable":
      return `${base} This pace is outside a realistic range; consider a longer timeframe or a smaller target.`;
  }
}

export interface FeasibilityInput {
  math: MissionMath;
  riskProfile: RiskProfile;
  feed?: FeedReadiness;
}

export function evaluateFeasibility(input: FeasibilityInput): FeasibilityVerdict {
  const { math, riskProfile } = input;
  const feed = input.feed ?? { ready: false, reason: "NO_FEED" };
  const warnings: string[] = [];

  // Fail-closed: degenerate inputs → Unreasonable, cannot start.
  if (math.invalid) {
    if (math.invalidReasons.includes("TARGET_NOT_ABOVE_STARTING")) {
      warnings.push("The target must be greater than the starting amount.");
    }
    if (math.invalidReasons.includes("TIMEFRAME_INVALID")) {
      warnings.push("The timeframe is invalid; the end must be after the start.");
    }
    if (math.invalidReasons.includes("STARTING_AMOUNT_INVALID")) {
      warnings.push("The starting amount must be a positive number.");
    }
    if (math.invalidReasons.includes("TARGET_AMOUNT_INVALID")) {
      warnings.push("The target amount must be a positive number.");
    }
    return {
      tier: "Unreasonable",
      feasibilityScore: 0,
      riskScore: 100,
      recommendedRiskProfile: "conservative",
      missionType: "unrealistic",
      warnings,
      explanation:
        "This mission cannot be assessed yet — please correct the inputs above. " +
        "Values shown are projections, not promises.",
      requiredReturnPct: math.requiredReturnPct,
      requiredDailyReturnPct: math.requiredDailyReturnPct,
      riskProfileMismatch: riskProfileMismatchFor(riskProfile, "conservative"),
      canStart: false,
      startBlockReason: "INVALID_INPUTS",
      isEstimate: true,
      unitAwareMissionClass: unitAwareMissionClassFor("Unreasonable", math.timeframeMinutes),
    };
  }

  const tier = tierFor(math.requiredDailyReturnPct);
  const missionType = missionTypeFor(tier);
  const recommendedRiskProfile = recommendedRiskProfileFor(math.requiredDailyReturnPct);

  // Feasibility score: smooth decay with required daily return.
  const feasibilityScore = clamp(
    round(100 * Math.exp(-math.requiredDailyReturnPct / 3.5)),
    0,
    100,
  );

  // Risk score: inverse of feasibility, amplified by an aggressive chosen
  // profile, an undersized account, and an impossibly short timeframe.
  let riskScore = 100 - feasibilityScore;
  if (riskProfile === "aggressive") riskScore += 6;
  if (riskProfile === "extreme") riskScore += 14;
  if (math.startingAmount < UNDERSIZED_ACCOUNT_FLOOR) riskScore += 10;
  if (math.totalDays < SHORT_TIMEFRAME_DAYS) riskScore += 12;
  riskScore = clamp(round(riskScore), 0, 100);

  const totalMinutes = math.timeframeMinutes;
  const unitAwareMissionClass = unitAwareMissionClassFor(tier, totalMinutes);

  // Warnings (advisory; block-only).
  if (tier === "Extreme" || tier === "Unreasonable") {
    warnings.push("This is a high-risk target; possible loss is elevated.");
  }
  if (math.startingAmount < UNDERSIZED_ACCOUNT_FLOOR) {
    warnings.push(
      `The starting amount is small (under ${UNDERSIZED_ACCOUNT_FLOOR}); costs and spreads weigh more heavily. ` +
        "Small balances have less room for drawdown and may be more affected by minimum lot sizing.",
    );
  }
  if (math.totalDays < SHORT_TIMEFRAME_DAYS) {
    warnings.push("The timeframe is very short, which sharply raises the required pace.");
  }
  // Short-timeframe specific warnings.
  if (totalMinutes > 0 && totalMinutes < MINUTES_PER_HOUR) {
    warnings.push(
      "Minute-based missions are very sensitive to spreads, slippage, and execution timing. " +
        "The required pace is extreme at this timeframe.",
    );
    if (totalMinutes <= 30) {
      warnings.push(
        "A 5–30 minute mission demands a confirmed live feed and fast execution to be actionable.",
      );
    }
  }
  if (riskProfile === "extreme") {
    warnings.push("An extreme risk profile increases possible loss on each position.");
  }

  // Feed readiness: DISPLAY ONLY. `canStart` says whether a confirmed feed was
  // observed; it is NOT an enforced gate — no caller consults it at start time
  // (`POST /profit-missions/:id/start` checks state-machine legality only), and
  // the planner surface offers no start control at all. So the copy must not
  // claim a block that nothing performs. We NEVER fabricate feasibility from a
  // stale/absent feed — the math-based estimate stands, labelled.
  const canStart = feed.ready === true;
  const startBlockReason = canStart ? null : feed.reason ?? "FEED_NOT_READY";
  if (!canStart) {
    warnings.push(
      "Live feed not confirmed — the planner drafts this mission and does not start it.",
    );
  }

  return {
    tier,
    feasibilityScore,
    riskScore,
    recommendedRiskProfile,
    missionType,
    warnings,
    explanation: explanationFor(tier, math),
    requiredReturnPct: math.requiredReturnPct,
    requiredDailyReturnPct: math.requiredDailyReturnPct,
    riskProfileMismatch: riskProfileMismatchFor(riskProfile, recommendedRiskProfile),
    canStart,
    startBlockReason,
    isEstimate: true,
    unitAwareMissionClass,
  };
}

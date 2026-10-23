// Agent Ecosystem — Layer 2: Promotion Board lifecycle (§6). PURE.
//
// Reads an agent's recent reviewed performance over rolling windows and
// recommends a status / rank / advisory-authority-weight transition.
//
// SAFETY / SCOPE:
//   - Authority is ADVISORY weight only — it influences ranking/visibility,
//     NEVER live execution, the 16-gate pipeline, or demo/live dispatch.
//   - A SHADOW agent (liveInfluenceAllowed=false) keeps authorityWeight 0 even
//     when its rank rises: real influence is unlocked ONLY by an admin (a
//     later layer), never auto-granted here. New agents always start Shadow 0%.
//   - Full shutdown requires admin (requiresAdmin=true). The board may only
//     RECOMMEND shutdown; it auto-applies softer states (Warning/Probation/
//     Restricted/Learning Camp) when safety requires.

import type { CouncilAgentGrade } from "../accountability/agentPerformance.types";

export type AgentRank = "TRAINEE" | "JUNIOR" | "ANALYST" | "SENIOR" | "LEAD" | "CHIEF";
export type AgentLifecycleStatus =
  | "ACTIVE" | "SHADOW" | "WARNING" | "PROBATION" | "RESTRICTED"
  | "LEARNING_CAMP" | "SHUTDOWN_RECOMMENDED" | "ARCHIVED";

export type LifecycleAction =
  | "PROMOTE" | "DEMOTE" | "WARN" | "PROBATION" | "RESTRICT"
  | "LEARNING_CAMP" | "SHUTDOWN_RECOMMEND" | "HOLD";

export const RANK_ORDER: readonly AgentRank[] =
  ["TRAINEE", "JUNIOR", "ANALYST", "SENIOR", "LEAD", "CHIEF"] as const;

// Rank -> advisory authority-weight band (0-1). Trainee/Shadow is 0%.
export const AUTHORITY_BANDS: Record<AgentRank, { min: number; max: number }> = {
  TRAINEE: { min: 0, max: 0 },
  JUNIOR: { min: 0.01, max: 0.05 },
  ANALYST: { min: 0.05, max: 0.10 },
  SENIOR: { min: 0.10, max: 0.20 },
  LEAD: { min: 0.20, max: 0.30 },
  CHIEF: { min: 0.30, max: 0.40 },     // configurable ceiling
};

export function authorityBandForRank(rank: AgentRank): { min: number; max: number } {
  return AUTHORITY_BANDS[rank] ?? AUTHORITY_BANDS.TRAINEE;
}

export function clampAuthorityToBand(weight: number, rank: AgentRank): number {
  const band = authorityBandForRank(rank);
  return +Math.max(band.min, Math.min(band.max, weight)).toFixed(4);
}

function rankIndex(rank: AgentRank): number {
  const i = RANK_ORDER.indexOf(rank);
  return i < 0 ? 0 : i;
}
function nextRank(rank: AgentRank): AgentRank {
  return RANK_ORDER[Math.min(RANK_ORDER.length - 1, rankIndex(rank) + 1)]!;
}
function prevRank(rank: AgentRank): AgentRank {
  return RANK_ORDER[Math.max(0, rankIndex(rank) - 1)]!;
}

export interface ReviewSummary {
  grade: CouncilAgentGrade;
  scoreDelta: number;               // -2..+2
}

function isPoor(r: ReviewSummary): boolean {
  return r.grade === "D" || r.grade === "F" || r.scoreDelta < 0;
}
function isGood(r: ReviewSummary): boolean {
  return r.grade === "A" || r.grade === "B";
}

export interface WindowStat { count: number; poor: number; good: number; avgScore: number; }
export interface LifecycleWindows {
  last10: WindowStat; last25: WindowStat; last50: WindowStat; last100: WindowStat;
}

function windowStat(reviews: ReviewSummary[], n: number): WindowStat {
  const slice = reviews.slice(0, n);
  const count = slice.length;
  const poor = slice.filter(isPoor).length;
  const good = slice.filter(isGood).length;
  // 0-100 score from scoreDelta (-2..+2 -> 0..100).
  const avgScore = count === 0 ? 50
    : +(slice.reduce((s, r) => s + ((r.scoreDelta + 2) / 4) * 100, 0) / count).toFixed(2);
  return { count, poor, good, avgScore };
}

/** Summarize the last 10/25/50/100 reviews (newest first). PURE. */
export function summarizeWindows(reviews: ReviewSummary[]): LifecycleWindows {
  return {
    last10: windowStat(reviews, 10),
    last25: windowStat(reviews, 25),
    last50: windowStat(reviews, 50),
    last100: windowStat(reviews, 100),
  };
}

export interface LifecycleEvaluation {
  action: LifecycleAction;
  recommendedStatus: AgentLifecycleStatus;
  recommendedRank: AgentRank;
  recommendedAuthorityWeight: number;
  poorRecent: number;
  windows: LifecycleWindows;
  requiresAdmin: boolean;
  reasons: string[];
}

/**
 * Evaluate an agent's lifecycle from its recent reviews (newest first).
 * Poor-count thresholds (§6): 3 -> Warning, 5 -> Probation,
 * 8 -> Restricted / Learning Camp, 10 -> Shutdown Recommended (admin only).
 */
export function evaluateAgentLifecycle(args: {
  currentStatus: AgentLifecycleStatus;
  currentRank: AgentRank;
  currentAuthorityWeight: number;
  liveInfluenceAllowed: boolean;
  reviews: ReviewSummary[];          // newest first
  learningCampImproved?: boolean;
}): LifecycleEvaluation {
  const { currentRank, currentAuthorityWeight, liveInfluenceAllowed } = args;
  const windows = summarizeWindows(args.reviews);
  const poorRecent = windows.last10.poor;
  const reasons: string[] = [];

  const weightFor = (rank: AgentRank): number =>
    liveInfluenceAllowed ? clampAuthorityToBand(currentAuthorityWeight || authorityBandForRank(rank).min, rank) : 0;

  // ── Degradation path (poor-count thresholds) ──────────────────────────────
  if (poorRecent >= 10) {
    reasons.push(`${poorRecent}/10 recent reviews poor — shutdown recommended (admin required)`);
    return {
      action: "SHUTDOWN_RECOMMEND", recommendedStatus: "SHUTDOWN_RECOMMENDED",
      recommendedRank: currentRank, recommendedAuthorityWeight: 0,
      poorRecent, windows, requiresAdmin: true, reasons,
    };
  }
  if (poorRecent >= 8) {
    reasons.push(`${poorRecent}/10 recent reviews poor — restrict + send to Learning Camp`);
    return {
      action: "LEARNING_CAMP", recommendedStatus: "LEARNING_CAMP",
      recommendedRank: prevRank(currentRank), recommendedAuthorityWeight: 0,
      poorRecent, windows, requiresAdmin: false, reasons,
    };
  }
  if (poorRecent >= 5) {
    reasons.push(`${poorRecent}/10 recent reviews poor — probation`);
    return {
      action: "PROBATION", recommendedStatus: "PROBATION",
      recommendedRank: currentRank, recommendedAuthorityWeight: weightFor(prevRank(currentRank)),
      poorRecent, windows, requiresAdmin: false, reasons,
    };
  }
  if (poorRecent >= 3) {
    reasons.push(`${poorRecent}/10 recent reviews poor — warning`);
    return {
      action: "WARN", recommendedStatus: "WARNING",
      recommendedRank: currentRank, recommendedAuthorityWeight: weightFor(currentRank),
      poorRecent, windows, requiresAdmin: false, reasons,
    };
  }

  // ── Improvement / promotion path ──────────────────────────────────────────
  if (args.learningCampImproved) {
    reasons.push("returned from Learning Camp with improved performance");
  }
  const canPromote = windows.last25.count >= 20
    && windows.last25.poor <= 2 && windows.last25.avgScore >= 70
    && rankIndex(currentRank) < RANK_ORDER.length - 1;
  if (canPromote) {
    const rank = nextRank(currentRank);
    reasons.push(`strong rolling performance (avg ${windows.last25.avgScore}, ${windows.last25.poor} poor / last 25) — promote to ${rank}`);
    return {
      action: "PROMOTE", recommendedStatus: "ACTIVE",
      recommendedRank: rank, recommendedAuthorityWeight: weightFor(rank),
      poorRecent, windows, requiresAdmin: false, reasons,
    };
  }

  const shouldDemote = windows.last25.count >= 20 && windows.last25.avgScore < 40
    && rankIndex(currentRank) > 0;
  if (shouldDemote) {
    const rank = prevRank(currentRank);
    reasons.push(`weak rolling performance (avg ${windows.last25.avgScore} / last 25) — demote to ${rank}`);
    return {
      action: "DEMOTE", recommendedStatus: "ACTIVE",
      recommendedRank: rank, recommendedAuthorityWeight: weightFor(rank),
      poorRecent, windows, requiresAdmin: false, reasons,
    };
  }

  reasons.push("performance within band — hold");
  return {
    action: "HOLD", recommendedStatus: args.currentStatus,
    recommendedRank: currentRank, recommendedAuthorityWeight: weightFor(currentRank),
    poorRecent, windows, requiresAdmin: false, reasons,
  };
}

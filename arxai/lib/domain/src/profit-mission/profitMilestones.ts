// ── Profit Mission Phase 8 — Profit Milestones, Protection Ladder & Giveback ────
//
// PLANNING / PROTECTIVE-only. Detects profit milestones (25/50/75/100% of the
// required profit), drives a profit-PROTECTION ladder (higher milestones allow
// only higher-quality setups), and runs a giveback guard that switches the
// mission to protect mode and reduces risk after the user gives back too much of
// a peak. At 100% the default is STOP + LOCK profit; continuing is allowed only
// with automatically reduced risk.
//
// HONESTY CONTRACT:
//   - This engine is STRICTER-ONLY: it can raise the minimum setup tier, cut the
//     risk multiplier, switch to protect, or stop — never loosen a limit.
//   - Unknown inputs fail safe toward MORE protection, never less.
//   - No guaranteed-profit vocabulary — "locked profit" means realised + secured.
//
// PURE + DETERMINISTIC + IO-FREE.

import type { MissionMode } from "./missionRisk.js";

/** Setup-quality tiers, ordered worst → best. */
export type SetupTier = "C" | "B" | "A" | "A_PLUS";
const TIER_RANK: Record<SetupTier, number> = { C: 0, B: 1, A: 2, A_PLUS: 3 };

export type MilestoneLevel = 0 | 25 | 50 | 75 | 100;

export interface MilestoneInput {
  /** Mission profit target in account currency (targetAmount - startingAmount). */
  requiredProfit?: number | null;
  /** REALISED profit so far in account currency (closed trades only). */
  realisedProfit?: number | null;
  /** Peak realised profit reached during the mission (for the giveback guard). */
  peakRealisedProfit?: number | null;
  /** Realised profit captured TODAY (for the daily-goal lock). */
  realisedProfitToday?: number | null;
  /** Daily profit goal in account currency (optional). */
  dailyProfitGoal?: number | null;
  /** Fraction of a peak that may be given back before protect kicks in (default 0.30). */
  givebackThreshold?: number | null;
  /** Does the user want to keep trading after hitting 100%? (default false = stop+lock) */
  continueAfterTarget?: boolean;
}

export interface MilestoneVerdict {
  /** Highest milestone reached (0/25/50/75/100). */
  milestone: MilestoneLevel;
  /** Realised profit that is now considered LOCKED / secured. */
  lockedProfit: number;
  /** Minimum setup tier the mission may now take (rises with milestones). */
  minSetupTier: SetupTier;
  /** Risk multiplier to apply on top of the profile risk (≤ 1; stricter-only). */
  riskMultiplier: number;
  /** Suggested mission mode escalation (never looser than the caller's mode). */
  suggestedMode: MissionMode;
  /** True when the mission should stop and lock profit (default at 100%). */
  stopAndLock: boolean;
  /** True when the giveback guard fired. */
  givebackTriggered: boolean;
  /** True when today's profit goal has been reached (lock/protect for the day). */
  dailyGoalReached: boolean;
  reasons: string[];
  warnings: string[];
}

function isNum(n: number | null | undefined): n is number {
  return n != null && Number.isFinite(n);
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function milestoneFor(pct: number): MilestoneLevel {
  if (pct >= 100) return 100;
  if (pct >= 75) return 75;
  if (pct >= 50) return 50;
  if (pct >= 25) return 25;
  return 0;
}

/** Minimum setup tier allowed at each milestone (the protection ladder). */
function tierForMilestone(m: MilestoneLevel): SetupTier {
  switch (m) {
    case 100:
    case 75:
      return "A_PLUS";
    case 50:
      return "A";
    case 25:
      return "B";
    default:
      return "C";
  }
}

/** Risk multiplier allowed at each milestone (stricter-only, ≤ 1). */
function riskMultiplierForMilestone(m: MilestoneLevel): number {
  switch (m) {
    case 100:
      return 0.25; // continue-after-target only with heavily reduced risk
    case 75:
      return 0.5;
    case 50:
      return 0.75;
    default:
      return 1;
  }
}

/** Return the stricter (higher) of two setup tiers. */
export function strictestTier(a: SetupTier, b: SetupTier): SetupTier {
  return TIER_RANK[a] >= TIER_RANK[b] ? a : b;
}

/**
 * Evaluate milestones, the protection ladder, the giveback guard, and the
 * daily-goal lock. Stricter-only: every output tightens (or holds) risk.
 */
export function evaluateMilestones(input: MilestoneInput): MilestoneVerdict {
  const reasons: string[] = [];
  const warnings: string[] = [];

  const required = isNum(input.requiredProfit) && input.requiredProfit > 0 ? input.requiredProfit : null;
  const realised = isNum(input.realisedProfit) ? input.realisedProfit : 0;
  const peak = isNum(input.peakRealisedProfit) ? Math.max(input.peakRealisedProfit, realised) : realised;

  if (required == null) {
    warnings.push("Required profit unknown — defaulting to maximum protection.");
    return {
      milestone: 0,
      lockedProfit: round2(Math.max(0, realised)),
      minSetupTier: "A_PLUS",
      riskMultiplier: 0.5,
      suggestedMode: "protect",
      stopAndLock: false,
      givebackTriggered: false,
      dailyGoalReached: false,
      reasons: ["Mission target unknown — protecting realised profit conservatively."],
      warnings,
    };
  }

  const pct = (realised / required) * 100;
  const milestone = realised > 0 ? milestoneFor(pct) : 0;
  if (milestone > 0) {
    reasons.push(`Reached the ${milestone}% milestone (${round2(pct)}% of target).`);
  }

  let minSetupTier = tierForMilestone(milestone);
  let riskMultiplier = riskMultiplierForMilestone(milestone);
  let suggestedMode: MissionMode = milestone >= 75 ? "protect" : "normal";

  // ── 100% target: default stop + lock; continue only with reduced risk. ───────
  const atTarget = milestone === 100;
  let stopAndLock = false;
  if (atTarget) {
    if (input.continueAfterTarget === true) {
      riskMultiplier = Math.min(riskMultiplier, 0.25);
      minSetupTier = "A_PLUS";
      suggestedMode = "protect";
      reasons.push("Target reached — continuing only with automatically reduced risk (A+ only).");
    } else {
      stopAndLock = true;
      suggestedMode = "stop";
      reasons.push("Target reached — default is to stop the mission and lock profit.");
    }
  }

  // ── Giveback guard: gave back ≥ threshold of the peak → protect + cut risk. ──
  const givebackThreshold = clamp(
    isNum(input.givebackThreshold) ? input.givebackThreshold : 0.3,
    0.05,
    0.9,
  );
  let givebackTriggered = false;
  if (peak > 0 && realised < peak) {
    const givenBack = (peak - realised) / peak;
    if (givenBack >= givebackThreshold) {
      givebackTriggered = true;
      riskMultiplier = Math.min(riskMultiplier, 0.5);
      minSetupTier = strictestTier(minSetupTier, "A");
      suggestedMode = "protect";
      reasons.push(
        `Gave back ${Math.round(givenBack * 100)}% of peak profit — switching to protect mode and reducing risk.`,
      );
    }
  }

  // ── Daily-goal lock: reached today's goal → protect/lock for the day. ────────
  let dailyGoalReached = false;
  if (isNum(input.dailyProfitGoal) && input.dailyProfitGoal > 0 && isNum(input.realisedProfitToday)) {
    if (input.realisedProfitToday >= input.dailyProfitGoal) {
      dailyGoalReached = true;
      riskMultiplier = Math.min(riskMultiplier, 0.5);
      suggestedMode = suggestedMode === "stop" ? "stop" : "protect";
      reasons.push("Daily profit goal reached — locking in the day and protecting gains.");
    }
  }

  // Locked profit is the secured realised profit (never negative, never floating).
  const lockedProfit = round2(Math.max(0, realised));

  return {
    milestone,
    lockedProfit,
    minSetupTier,
    riskMultiplier: round2(clamp(riskMultiplier, 0.1, 1)),
    suggestedMode,
    stopAndLock,
    givebackTriggered,
    dailyGoalReached,
    reasons: reasons.length > 0 ? reasons : ["No profit milestone reached yet."],
    warnings,
  };
}

/** Does a candidate setup tier clear the milestone's minimum? Pure helper. */
export function setupClearsMilestone(candidate: SetupTier, minTier: SetupTier): boolean {
  return TIER_RANK[candidate] >= TIER_RANK[minTier];
}

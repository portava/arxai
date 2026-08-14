// ── Profit Mission planner — pure presentation helpers ───────────────────────
//
// DISPLAY-ONLY. These helpers decide the planner's save/start button label and
// derive a tiny bit of formatting from a feasibility verdict. They NEVER decide
// whether a mission may execute — `canStartMission` only mirrors the feed-gated
// `canStart` flag the domain engine already computed. Nothing here can relax,
// override, or trigger any execution gate. Kept in a sibling module (not the
// page component) so they stay unit-testable and Vite fast-refresh-safe.

import type { FeasibilityVerdict } from "@workspace/domain/profit-mission";

/** Primary-action labels for the two-step assess → save flow. */
export const PLANNER_ACTION_LABELS = {
  /** Step 1: nothing assessed yet. */
  ASSESS: "Assess mission",
  /** Step 2: assessed, feed confirmed, realistic — start is permitted. */
  SAVE_AND_START: "Save & start mission",
  /** Step 2: assessed, realistic, but feed not confirmed — draft only. */
  SAVE_DRAFT: "Save draft only",
  /** Step 2: assessed and the target is unreasonable — draft only, labelled. */
  SAVE_UNREALISTIC_DRAFT: "Save unrealistic draft",
} as const;

export type PlannerActionLabel =
  (typeof PLANNER_ACTION_LABELS)[keyof typeof PLANNER_ACTION_LABELS];

/**
 * Whether the mission may START. This is purely a mirror of the feed-gated
 * `canStart` flag the domain feasibility engine already produced — it adds no
 * new permission and can only ever be as permissive as the engine. In Phase 1
 * the feed is never confirmed, so this is always false.
 */
export function canStartMission(feasibility: FeasibilityVerdict | null): boolean {
  return feasibility?.canStart === true;
}

/** True when the assessed target is in the unreasonable tier. */
export function isUnrealisticMission(feasibility: FeasibilityVerdict | null): boolean {
  return feasibility?.tier === "Unreasonable";
}

/**
 * Resolve the primary-action button label for the two-step planner flow.
 *
 * - Not assessed yet ............................ "Assess mission"
 * - Assessed + unreasonable target ............. "Save unrealistic draft"
 * - Assessed + realistic + feed confirmed ...... "Save & start mission"
 * - Assessed + realistic + feed NOT confirmed .. "Save draft only"
 */
export function resolvePrimaryActionLabel(
  assessed: boolean,
  feasibility: FeasibilityVerdict | null,
): PlannerActionLabel {
  if (!assessed || !feasibility) return PLANNER_ACTION_LABELS.ASSESS;
  if (isUnrealisticMission(feasibility)) {
    return PLANNER_ACTION_LABELS.SAVE_UNREALISTIC_DRAFT;
  }
  if (canStartMission(feasibility)) return PLANNER_ACTION_LABELS.SAVE_AND_START;
  return PLANNER_ACTION_LABELS.SAVE_DRAFT;
}

/** Trim a percentage to at most 2 decimals with no trailing zeros: 100 → "100%". */
export function pctTrim(n: number): string {
  const safe = Number.isFinite(n) ? n : 0;
  return `${Number(safe.toFixed(2))}%`;
}

/** Per-day variant of {@link pctTrim}: 100 → "100% per day". */
export function pctTrimPerDay(n: number): string {
  return `${pctTrim(n)} per day`;
}

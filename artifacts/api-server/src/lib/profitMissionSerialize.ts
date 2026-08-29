// Pure serialization for the Profit Mission read surfaces (list / get-by-id /
// pulse). Extracted from the route so the serialization CONTRACT can be locked
// by a PURE, DB-free unit test: every mission read surface must always carry the
// planner-honesty fields — the risk-profile mismatch, the required-pace numbers,
// and the planning-projection note — so the planner can never go silently
// inconsistent or dishonest on a page-by-page basis.
//
// SAFETY / SCOPE:
//   - No IO, no clock (callers pass `nowMs`), no `@workspace/db` RUNTIME import
//     (the row type is a TYPE-ONLY import, fully erased), so this module stays in
//     the offline `ci` lane alongside the pure engine suite.
//   - The route NEVER re-derives the planner math; it composes these pure
//     engines and projects the result through the helpers here, keeping every
//     surface byte-for-byte consistent.
import type { profitMissionsTable } from "@workspace/db";
import {
  computeMissionMath,
  evaluateFeasibility,
  evaluateProbability,
  type FeedReadiness,
  type MissionMath,
  type FeasibilityVerdict,
  type MissionProbabilityScore,
  type RiskProfile,
} from "@workspace/domain/profit-mission";

export type MissionRow = typeof profitMissionsTable.$inferSelect;

export const VALID_RISK_PROFILES: readonly RiskProfile[] = [
  "conservative",
  "balanced",
  "aggressive",
  "extreme",
];

/**
 * Honest feed readiness for a mission. Phase 1 is planning + display only — no
 * execution feed is wired for missions yet — so START stays blocked and drafts
 * are always allowed. We never fabricate "feed ready" to enable a start.
 */
export function resolveFeedReadiness(): FeedReadiness {
  return { ready: false, reason: "FEED_NOT_CONFIRMED" };
}

export interface MissionAssessment {
  math: MissionMath;
  feasibility: FeasibilityVerdict;
  probability: MissionProbabilityScore;
}

/** Compose the pure engines into a full assessment for a mission row. */
export function assess(row: MissionRow, nowMs: number): MissionAssessment {
  const riskProfile = (VALID_RISK_PROFILES as readonly string[]).includes(row.riskProfile)
    ? (row.riskProfile as RiskProfile)
    : "balanced";
  const math = computeMissionMath({
    startingAmount: row.startingAmount,
    targetAmount: row.targetAmount,
    timeframeStartMs: row.timeframeStart.getTime(),
    timeframeEndMs: row.timeframeEnd.getTime(),
    currentValue: row.currentValue,
    nowMs,
  });
  const feasibility = evaluateFeasibility({
    math,
    riskProfile,
    feed: resolveFeedReadiness(),
  });
  const probability = evaluateProbability({
    math,
    feasibility,
    riskProfile,
    sampleSize: 0,
  });
  return { math, feasibility, probability };
}

/**
 * Which books a mission's money figures are on. A `live` mission's currentValue
 * / realised profit is broker-reconciled money; a paper/demo mission's is a
 * SIMULATED total, summed from fills modelled against real quotes. The two are
 * never blended, and every read surface states which one it is showing.
 */
export type MissionAccountingBasis = "SIMULATED" | "BROKER_RECONCILED";

/** PURE — `live` and only `live` is money. */
export function accountingBasisFor(executionMode: string | null | undefined): MissionAccountingBasis {
  return (executionMode ?? "").trim().toLowerCase() === "live" ? "BROKER_RECONCILED" : "SIMULATED";
}

/** The honesty label every surface shows beside a mission money figure. */
export function accountingLabelFor(basis: MissionAccountingBasis): string {
  return basis === "SIMULATED"
    ? "SIMULATED — modelled from real quotes on a paper/demo mission, not broker-reconciled money"
    : "Broker-reconciled realised money";
}

/** Project a row + assessment into the public ProfitMission DTO. */
export function serialize(row: MissionRow, a: MissionAssessment) {
  const accountingBasis = accountingBasisFor(row.executionMode);
  return {
    id: row.id,
    userId: row.userId,
    startingAmount: row.startingAmount,
    targetAmount: row.targetAmount,
    requiredProfit: row.requiredProfit,
    currentValue: row.currentValue,
    // The honesty label for `currentValue` (and every derived math figure).
    accountingBasis,
    currentValueSimulated: accountingBasis === "SIMULATED",
    accountingLabel: accountingLabelFor(accountingBasis),
    timeframeStart: row.timeframeStart.toISOString(),
    timeframeEnd: row.timeframeEnd.toISOString(),
    timeframeAmount: row.timeframeAmount ?? null,
    timeframeUnit: row.timeframeUnit ?? null,
    timeframeMinutes: row.timeframeMinutes ?? null,
    timeframeLabel: row.timeframeLabel ?? null,
    riskProfile: row.riskProfile,
    executionMode: row.executionMode,
    automationLevel: row.automationLevel,
    status: row.status,
    currentMode: row.currentMode,
    settings: (row.settingsJson as Record<string, unknown> | null) ?? null,
    math: a.math,
    feasibility: a.feasibility,
    probability: a.probability,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  };
}

/**
 * Async, DB-derived extras resolved by the pulse handler (risk recompute, Phase 7
 * execution health / exposure, Phase 8 protection snapshot, and the `asOf`
 * stamp). They are passed in already-resolved so this projector stays pure and
 * the live-recompute surface carries the SAME planner-honesty assessment fields
 * as the list / get-by-id surfaces.
 */
export interface MissionPulseExtras {
  risk: unknown;
  executionHealth: unknown;
  exposure: unknown;
  protection: unknown;
  asOf: string;
}

/** Project a row + assessment + resolved extras into the pulse/refresh DTO. */
export function serializePulse(row: MissionRow, a: MissionAssessment, extras: MissionPulseExtras) {
  const accountingBasis = accountingBasisFor(row.executionMode);
  return {
    id: row.id,
    currentValue: row.currentValue,
    accountingBasis,
    currentValueSimulated: accountingBasis === "SIMULATED",
    accountingLabel: accountingLabelFor(accountingBasis),
    math: a.math,
    feasibility: a.feasibility,
    probability: a.probability,
    risk: extras.risk,
    executionHealth: extras.executionHealth,
    exposure: extras.exposure,
    protection: extras.protection,
    asOf: extras.asOf,
  };
}
